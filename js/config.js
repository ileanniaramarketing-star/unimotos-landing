/* ==========================================================================
   UNIMOTOS · CONFIGURAÇÃO DAS LANDING PAGES (/motos e /carros)
   Tudo que é específico do cliente fica aqui. Este arquivo é PÚBLICO (roda no navegador):
   NUNCA coloque token, senha ou chave de API aqui. Segredos ficam só no cofre/servidor.
   ========================================================================== */
window.UNI_CONFIG = {

  /* --- Contato --------------------------------------------------------- */
  // WhatsApp com DDI+DDD, só números. Ex.: "5531999998888"
  // ⚠️ TROCAR pelo número real antes de rodar campanha.
  whatsapp: "5500000000000",
  // Telefone para o botão "Ligar" (mobile). Deixe "" para esconder.
  phone: "",

  /* --- Mensagens do WhatsApp (uma por veículo) --------------------------- */
  messages: {
    // botões "Falar no WhatsApp"
    default: {
      moto: "Olá! Vim pelo anúncio e quero cotar a proteção veicular da minha moto.",
      carro: "Olá! Vim pelo anúncio e quero cotar a proteção veicular do meu carro."
    },
    // aberta após o formulário de cotação (nome e placa são anexados automaticamente)
    quote: {
      moto: "Olá! Vim pelo anúncio e acabei de fazer a cotação da minha moto pela placa.",
      carro: "Olá! Vim pelo anúncio e acabei de fazer a cotação do meu carro pela placa."
    }
  },

  /* --- Envio do lead ---------------------------------------------------- */
  // "/api/lead" = endpoint do PRÓPRIO servidor do site (scripts/serve.js), que guarda o token do
  // Power CRM e encaminha o lead ao funil. O navegador nunca vê o token.
  // Também aceita uma URL externa (Make, n8n…); vazio = só abre o WhatsApp.
  leadWebhook: "/api/lead",

  /* --- Consulta automática da placa (opcional) ------------------------- */
  // URL de um endpoint SEU (ex.: Supabase Edge Function) que recebe ?placa=ABC1D23,
  // consulta a API de placas com a chave guardada no servidor e devolve JSON:
  //   { "marca": "HONDA", "modelo": "CG 160 FAN", "ano": "2022", "cor": "PRETA" }
  // Vazio = o formulário só coleta a placa, sem consultar.
  plateLookupUrl: "",

  /* --- Rastreamento (deixe vazio para não carregar) --------------------- */
  gtmId: "",          // ex.: "GTM-XXXXXXX"
  metaPixelId: "",    // ex.: "1234567890"
  ga4Id: "",          // ex.: "G-XXXXXXXXXX"

  /* --- Rodapé / institucional ------------------------------------------ */
  footer: {
    address: "Av. Riacho das Pedras, 729 · Contagem / MG",   // ⚠️ confirmar com o cliente
    hours: "",        // ex.: "Seg a Sex 8h–18h" (vazio = não mostra)
    instagram: "",    // ex.: "https://instagram.com/unimotos"
    facebook: ""
  },

  /* --- Selo de preço do hero ("a partir de R$ X/mês") -------------------- */
  // Vem da arte da campanha de carros (R$ 56/mês). Moto: preencher quando houver o valor.
  // Vazio = o selo não aparece. Mostra também a observação de rodapé "sujeito ao modelo, ano e FIPE".
  price: { moto: "", carro: "56" },

  /* --- Números institucionais (seção "stats") ---------------------------- */
  // ⚠️ Retirados do site institucional da associação: CONFIRMAR com o cliente antes de publicar.
  // Para esconder a seção, deixe a lista vazia: stats: []
  stats: [
    { value: 15, prefix: "", suffix: "", label: "anos de história" },
    { value: 5000, prefix: "+", suffix: "", label: "veículos reparados" },
    { value: 4800, prefix: "+", suffix: "", label: "indenizações pagas" }
  ],

  /* --- Fotos dos cards de tipo de veículo -------------------------------- */
  // Opcional. Use caminhos absolutos, ex.: "/assets/motos/urbanas.jpg".
  // Chaves: motos → urbanas, street, trail, custom, esportivas · carros → hatch, sedan, suv, picape, esportivo
  photos: {},

  /* --- Avaliações do Google -------------------------------------------- */
  // Só aparece se houver itens. Use avaliações REAIS. Ex.:
  // { name: "João S.", text: "Atendimento excelente...", stars: 5 }
  reviews: [],
  reviewsLink: ""
};
