// Edge Function "send-lead" — roda na infraestrutura do próprio Supabase, acionada sozinha por um
// Database Webhook assim que um lead é INSERIDO na tabela `leads` com status "pendente" (o vendedor
// já vem decidido nessa mesma linha — ver scripts/lib/powercrm.js no projeto Node).
//
// Por quê aqui e não na Hostinger? A hospedagem da Hostinger pode encerrar o processo Node logo
// depois de responder ao navegador (comportamento tipo "serverless"); um envio deixado "em segundo
// plano" lá corria risco de ser cortado no meio, sem erro nenhum — foi o que aconteceu de verdade em
// produção (2026-09-30, lead "Ilean teste" ficou preso em "pendente" pra sempre). O Supabase não tem
// essa limitação: a função roda até terminar (ou até o tempo-limite da plataforma), de forma
// desacoplada da resposta que já foi entregue ao navegador.
//
// Configuração do Power CRM (NÃO secreta — mesmos dados de config/powercrm.json do projeto Node;
// se mudar vendedor/PowerLink/cidade/cooperativa, atualize os DOIS lugares). O token É secreto:
// vem de Deno.env.get("POWERCRM_TOKEN"), configurado como Function Secret no Supabase (nunca aqui).
const POWERCRM_CONFIG = {
  baseUrl: "https://api.powercrm.com.br",
  authHeader: "Authorization",
  authScheme: "Bearer",
  createQuotationPath: "api/quotation/add",
  defaults: { cityId: 1770 },
  origins: { default: 2424, social: 625, google: 624 },
  sellers: [
    { name: "Vitor", code: "ArzMy08D" },
    { name: "Kethlen", code: "orgpm2mE" }
    // "Ilean (teste)" fica de fora de propósito: inativa, nunca deve receber lead
  ],
  products: {
    moto: { coop: null as number | null, cityId: null as number | null },
    carro: { coop: null as number | null, cityId: null as number | null }
  }
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const POWERCRM_TOKEN = Deno.env.get("POWERCRM_TOKEN") || "";
// segredo compartilhado só com o próprio gatilho (Database Webhook) do banco — a função roda com
// verify_jwt=false (obrigatório pra um gatilho de banco conseguir chamar), então sem isso qualquer
// um que descobrisse a URL da função conseguiria forçar envios falsos ao Power CRM.
const WEBHOOK_SHARED_SECRET = Deno.env.get("WEBHOOK_SHARED_SECRET") || "";

// "5531987654321" -> "(31) 98765-4321" (mesmo formato que o Power CRM mostra)
function maskPhone(e164: string): string {
  let d = (e164 || "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  const ddd = d.slice(0, 2), n = d.slice(2);
  return "(" + ddd + ") " + (n.length === 9 ? n.slice(0, 5) + "-" + n.slice(5) : n.slice(0, 4) + "-" + n.slice(4));
}

function originFor(utmSource: string | null | undefined): number {
  const src = (utmSource || "").toLowerCase();
  if (/insta|face|meta|^fb$|^ig$/.test(src)) return POWERCRM_CONFIG.origins.social;
  if (/google|gads|adwords/.test(src)) return POWERCRM_CONFIG.origins.google;
  return POWERCRM_CONFIG.origins.default;
}

async function updateLead(id: string, fields: Record<string, unknown>): Promise<void> {
  await fetch(SUPABASE_URL + "/rest/v1/leads?id=eq." + id, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE_KEY,
      Authorization: "Bearer " + SERVICE_ROLE_KEY
    },
    body: JSON.stringify(fields)
  });
}

type LeadRecord = {
  id: string;
  veiculo: "moto" | "carro";
  nome: string;
  telefone: string;
  placa: string;
  utm_source: string | null;
  vendedor: string | null;
  status: string;
};

Deno.serve(async (req: Request) => {
  if (!WEBHOOK_SHARED_SECRET || req.headers.get("x-webhook-secret") !== WEBHOOK_SHARED_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  let payload: { record?: LeadRecord };
  try { payload = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
  const record = payload.record;

  // só processa leads recém-criados esperando envio (ignora dry-run, duplicado, not_configured,
  // no_token, e qualquer chamada repetida/fora de ordem — nunca reprocessa o que já não é "pendente")
  if (!record || record.status !== "pendente" || !record.vendedor) {
    return new Response("skip (não é um envio pendente)", { status: 200 });
  }
  if (!POWERCRM_TOKEN) {
    await updateLead(record.id, { status: "failed", status_ts: new Date().toISOString() });
    return new Response("sem POWERCRM_TOKEN configurado no Supabase", { status: 200 });
  }

  const seller = POWERCRM_CONFIG.sellers.find((s) => s.name === record.vendedor);
  if (!seller) {
    await updateLead(record.id, { status: "failed", status_ts: new Date().toISOString() });
    return new Response("vendedor desconhecido: " + record.vendedor, { status: 200 });
  }
  const prod = POWERCRM_CONFIG.products[record.veiculo] || { coop: null, cityId: null };
  const cityId = prod.cityId || POWERCRM_CONFIG.defaults.cityId;

  const body: Record<string, unknown> = {
    name: record.nome,
    phone: maskPhone(record.telefone),
    plts: record.placa,
    city: cityId,
    origemId: originFor(record.utm_source),
    slsmnNwId: seller.code, // PowerLink do consultor = quem recebe o lead
    workVehicle: false
  };
  if (prod.coop != null) body.coop = prod.coop;

  // até 3 tentativas DENTRO da própria execução da função (bem mais curto que os minutos que a
  // Hostinger usava — não precisa: aqui a função só termina quando o trabalho termina)
  const delays = [0, 2000, 5000];
  let lastError = "";
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      let res: Response;
      try {
        res = await fetch(POWERCRM_CONFIG.baseUrl + "/" + POWERCRM_CONFIG.createQuotationPath, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            [POWERCRM_CONFIG.authHeader]: POWERCRM_CONFIG.authScheme + " " + POWERCRM_TOKEN
          },
          body: JSON.stringify(body),
          signal: ctrl.signal
        });
      } finally { clearTimeout(timer); }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { lastError = "HTTP " + res.status; continue; }
      await updateLead(record.id, {
        status: "sent",
        status_ts: new Date().toISOString(),
        crm_quotation_code: json.quotationCode || null,
        crm_negotiation_code: json.negotiationCode || null
      });
      return new Response("ok", { status: 200 });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  await updateLead(record.id, { status: "failed", status_ts: new Date().toISOString() });
  // 200 de propósito: o "falhou" já foi registrado no lead; não queremos que o Supabase re-envie o
  // webhook (ele só re-tenta em erro de ENTREGA do webhook, não em erro de negócio como esse)
  return new Response("falhou: " + lastError, { status: 200 });
});
