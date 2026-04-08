const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
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

function buildPlainContainer(contentLines) {
  const sections = contentLines.filter(Boolean).join("\n");
  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(sections));
}

function buildNoPlanResponse() {
  const baseAppUrl = normalizeBaseAppUrl();

  const components = [
    buildPlainContainer([
      "## Nenhum plano encontrado",
      "-# Nao encontramos compras vinculadas a sua conta Discord. Escolha um plano para liberar os recursos no Flowdesk.",
    ]),
    new SeparatorBuilder()
      .setSpacing(SeparatorSpacingSize.Small)
      .setDivider(true),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Adquirir um plano")
        .setURL(baseAppUrl),
    ),
  ];

  return { components };
}

function buildPlanResponse(snapshot) {
  const baseAppUrl = normalizeBaseAppUrl();
  const dashboardUrl = `${baseAppUrl}/servers`;
  const statusLabel =
    snapshot.status === "active"
      ? "Licenca valida"
      : "Licenca expirada (historico de compra encontrado)";

  const components = [
    buildPlainContainer([
      "## Plano da sua conta",
      "-# Dados sincronizados com sua conta no Flowdesk. Para gerenciar servidores e assinatura, abra o dashboard.",
    ]),
    new SeparatorBuilder()
      .setSpacing(SeparatorSpacingSize.Small)
      .setDivider(true),
    buildPlainContainer([
      `**Plano**\n${snapshot.planName || "Nao informado"}`,
      "",
      `**Status**\n${statusLabel}`,
      "",
      `**Vence em**\n${toDiscordTimestamp(snapshot.expiresAt)}`,
      "",
      `**Ultima compra**\n${toDiscordTimestamp(snapshot.purchasedAt)}`,
      "",
      `**Ultimo valor pago**\n${formatMoney(snapshot.amount, snapshot.currency)}`,
    ]),
    new SeparatorBuilder()
      .setSpacing(SeparatorSpacingSize.Small)
      .setDivider(true),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Verificar meu plano")
        .setURL(dashboardUrl),
    ),
  ];

  return { components };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verificar-plano")
    .setDescription("Mostra o status do plano vinculado a sua conta Flowdesk."),

  async execute(interaction) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
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
        components: [
          buildPlainContainer([
            "## Nao foi possivel consultar seu plano",
            "-# Ocorreu um erro ao sincronizar os dados da sua conta. Tente novamente em alguns segundos.",
          ]),
        ],
      });
    }
  },
};
