/* ==========================================================================
   UNIMOTOS · CONFIGURAÇÃO DA LANDING PAGE
   Tudo que é específico do cliente fica aqui. Não precisa mexer no HTML.
   ========================================================================== */
window.UNI_CONFIG = {

  /* --- Contato --------------------------------------------------------- */
  // WhatsApp com DDI+DDD, só números. Ex.: "5549988170588"
  // ⚠️ TROCAR pelo número real antes de rodar campanha.
  whatsapp: "5500000000000",
  // Telefone para o botão "Ligar" (mobile). Deixe "" para esconder.
  phone: "",

  /* --- Mensagens do WhatsApp ------------------------------------------- */
  messages: {
    default: "Olá! Vim pelo anúncio e quero saber mais sobre as motos da Unimotos.",
    // usada quando a pessoa clica em uma categoria
    category: "Olá! Vim pelo anúncio e tenho interesse em motos do tipo: {categoria}.",
    // usada pelo formulário (o resumo das respostas é anexado automaticamente)
    form: "Olá! Vim pelo anúncio e acabei de preencher o formulário."
  },

  /* --- Captura de lead -------------------------------------------------- */
  // Opcional. URL que recebe o POST (JSON) do formulário: Supabase Edge Function,
  // RD Station, Make, n8n, Zapier, etc. Vazio = só abre o WhatsApp.
  leadWebhook: "",

  /* --- Rastreamento (deixe vazio para não carregar) --------------------- */
  gtmId: "",          // ex.: "GTM-XXXXXXX"
  metaPixelId: "",    // ex.: "1234567890"
  ga4Id: "",          // ex.: "G-XXXXXXXXXX"

  /* --- Rodapé / institucional ------------------------------------------ */
  footer: {
    address: "Endereço da loja · Cidade / UF",
    hours: "Seg a Sex 8h–18h · Sáb 8h–12h",
    instagram: "",    // ex.: "https://instagram.com/unimotos01"
    facebook: ""      // ex.: "https://facebook.com/unimotos01"
  },

  /* --- Fotos dos cards de estilo ---------------------------------------- */
  // Opcional. Coloque as fotos em assets/motos/ e informe o caminho.
  // Vazio = o card usa o fundo vermelho/preto padrão (sem requisição extra).
  photos: {
    urbanas: "",      // ex.: "assets/motos/urbanas.jpg"
    street: "",
    trail: "",
    custom: "",
    esportivas: ""
  },

  /* --- Avaliações do Google -------------------------------------------- */
  // Só aparece se houver itens. Use avaliações REAIS. Ex.:
  // { name: "João S.", text: "Atendimento excelente...", stars: 5 }
  reviews: [],
  reviewsLink: "",    // link "Ver todas as avaliações" (Google Maps)
  rating: ""          // ex.: "4,9"
};
