const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} = require("discord.js");
const { env } = require("../config/env");
const { getUserPlanSnapshotByDiscordUserId } = require("../services/supabaseService");

function normalizeBaseAppUrl() {
  const candidate =
    typeof env.appUrl === "string" && env.appUrl.trim()
      ? env.appUrl.trim()
      : "https://flwdesk.com";
  return candidate.replace(/\/+$/, "");
}

function toDiscordTimestamp(value) {
  if (!value || typeof value !== "string") return "Nao informado";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Nao informado";
  const unix = Math.floor(parsed / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function formatMoney(amount, currency = "BRL") {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return "Nao informado";
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.round(amount * 100) / 100);
}

function buildNoPlanResponse() {
  const baseAppUrl = normalizeBaseAppUrl();
  const embed = new EmbedBuilder()
    .setColor(0x3a3a3a)
    .setTitle("Nenhum plano encontrado")
    .setDescription(
      "Nao encontramos compras vinculadas a sua conta Discord. Escolha um plano para liberar os recursos no Flowdesk.",
    );

  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Adquirir um plano")
        .setURL(baseAppUrl),
    ),
  ];

  return { embeds: [embed], components };
}

function buildPlanResponse(snapshot) {
  const baseAppUrl = normalizeBaseAppUrl();
  const dashboardUrl = `${baseAppUrl}/servers`;
  const statusLabel =
    snapshot.status === "active"
      ? "Licenca valida"
      : "Licenca expirada (historico de compra encontrado)";

  const embed = new EmbedBuilder()
    .setColor(0x2d7ff9)
    .setTitle("Plano da sua conta")
    .setDescription(
      "Dados sincronizados com sua conta no Flowdesk. Para gerenciar servidores e assinatura, abra o dashboard.",
    )
    .addFields(
      {
        name: "Plano",
        value: snapshot.planName || "Nao informado",
        inline: true,
      },
      {
        name: "Status",
        value: statusLabel,
        inline: true,
      },
      {
        name: "Vence em",
        value: toDiscordTimestamp(snapshot.expiresAt),
        inline: false,
      },
      {
        name: "Ultima compra",
        value: toDiscordTimestamp(snapshot.purchasedAt),
        inline: false,
      },
      {
        name: "Ultimo valor pago",
        value: formatMoney(snapshot.amount, snapshot.currency),
        inline: true,
      },
    );

  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Verificar meu plano")
        .setURL(dashboardUrl),
    ),
  ];

  return { embeds: [embed], components };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verificar-plano")
    .setDescription("Mostra o status do plano vinculado a sua conta Flowdesk."),

  async execute(interaction) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    try {
      const snapshot = await getUserPlanSnapshotByDiscordUserId(interaction.user.id);
      if (!snapshot?.hasPlan) {
        await interaction.editReply(buildNoPlanResponse());
        return;
      }

      await interaction.editReply(buildPlanResponse(snapshot));
    } catch (error) {
      console.error("[verificar-plano] Falha ao consultar plano da conta:", error);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xbf3131)
            .setTitle("Nao foi possivel consultar seu plano")
            .setDescription(
              "Ocorreu um erro ao sincronizar os dados da sua conta. Tente novamente em alguns segundos.",
            ),
        ],
      });
    }
  },
};
