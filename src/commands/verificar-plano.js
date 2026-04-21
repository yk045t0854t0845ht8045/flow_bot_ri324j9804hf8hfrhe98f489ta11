const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
} = require("discord.js");
const { env } = require("../config/env");
const { getUserPlanSnapshotByDiscordUserId } = require("../services/supabaseService");

const STATUS_PAGE_URL = env.statusPageUrl;

function normalizeBaseAppUrl() {
  const candidate =
    typeof env.appUrl === "string" && env.appUrl.trim()
      ? env.appUrl.trim()
      : "https://www.flwdesk.com";
  return candidate.replace(/\/+$/, "");
}

function normalizeDashboardUrl() {
  const baseAppUrl = normalizeBaseAppUrl();

  try {
    const url = new URL(baseAppUrl);

    if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
      url.hostname = "fdesk.localhost";
    } else if (
      url.hostname === "flwdesk.com" ||
      url.hostname === "www.flwdesk.com" ||
      url.hostname.endsWith(".flwdesk.com")
    ) {
      url.hostname = "fdesk.flwdesk.com";
    }

    url.pathname = "/";
    url.search = "";
    url.hash = "";

    return url.toString().replace(/\/+$/, "");
  } catch {
    return "https://fdesk.flwdesk.com";
  }
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

function buildLinkButtonRow(label, url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url),
  );
}

function buildComponentsV2Card(input) {
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${input.title}\n-# ${input.description}`),
  );

  if (input.detailsMarkdown) {
    container
      .addSeparatorComponents(
        new SeparatorBuilder()
          .setSpacing(SeparatorSpacingSize.Small)
          .setDivider(true),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(input.detailsMarkdown),
      );
  }

  container
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setSpacing(SeparatorSpacingSize.Small)
        .setDivider(true),
    )
    .addSectionComponents(
      new SectionBuilder()
        .setButtonAccessory(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(input.buttonLabel)
            .setURL(input.buttonUrl),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            input.buttonHint ||
              "-# Acesse o link para abrir o painel e continuar a gestao da conta.",
          ),
        ),
    );

  return { components: [container] };
}

function buildNoPlanPayloads() {
  const baseAppUrl = normalizeBaseAppUrl();

  return {
    v2: buildComponentsV2Card({
      title: "Nenhum plano encontrado",
      description:
        "Nao encontramos compras vinculadas a sua conta Discord. Escolha um plano para liberar os recursos no Flowdesk.",
      buttonLabel: "Adquirir um plano",
      buttonUrl: baseAppUrl,
      buttonHint: "-# Clique para conhecer os planos e iniciar sua assinatura.",
    }),
    fallback: {
      content:
        "Nenhum plano encontrado para sua conta.\nUse o botao abaixo para adquirir um plano no Flowdesk.",
      components: [buildLinkButtonRow("Adquirir um plano", baseAppUrl)],
    },
  };
}

function buildPlanPayloads(snapshot) {
  const dashboardUrl = normalizeDashboardUrl();
  const statusLabel =
    snapshot.status === "active"
      ? "Licenca valida"
      : "Licenca expirada (historico de compra encontrado)";

  return {
    v2: buildComponentsV2Card({
      title: "Plano da sua conta",
      description:
        "Dados sincronizados com sua conta no Flowdesk. Para gerenciar servidores e assinatura, abra o dashboard.",
      detailsMarkdown: [
        "### Resumo da assinatura",
        `-# Plano: ${snapshot.planName || "Nao informado"}`,
        `-# Status: ${statusLabel}`,
        `-# Ultimo valor pago: ${formatMoney(snapshot.amount, snapshot.currency)}`,
        `-# Vence em: ${toDiscordTimestamp(snapshot.expiresAt)}`,
        `-# Ultima compra: ${toDiscordTimestamp(snapshot.purchasedAt)}`,
      ].join("\n"),
      buttonLabel: "Abrir dashboard",
      buttonUrl: dashboardUrl,
      buttonHint:
        "-# Abra o painel para gerenciar servidores, assinatura e pagamentos vinculados a sua conta.",
    }),
    fallback: {
      content:
        "Plano encontrado para sua conta.\n" +
        `Plano: ${snapshot.planName || "Nao informado"}\n` +
        `Status: ${statusLabel}\n` +
        `Ultimo valor pago: ${formatMoney(snapshot.amount, snapshot.currency)}\n` +
        `Vence em: ${toDiscordTimestamp(snapshot.expiresAt)}\n` +
        `Ultima compra: ${toDiscordTimestamp(snapshot.purchasedAt)}`,
      components: [buildLinkButtonRow("Abrir dashboard", dashboardUrl)],
    },
  };
}

function buildErrorPayloads() {
  return {
    v2: buildComponentsV2Card({
      title: "Nao foi possivel consultar seu plano",
      description:
        "Tivemos uma falha temporaria ao sincronizar os dados da sua conta. Tente novamente em alguns segundos.",
      buttonLabel: "Verificar status",
      buttonUrl: STATUS_PAGE_URL,
      buttonHint:
        "-# Se o problema continuar, acompanhe o status da plataforma e tente novamente.",
    }),
    fallback: {
      content:
        "Nao foi possivel consultar seu plano agora.\n" +
        "Tente novamente em alguns segundos ou acompanhe o status da plataforma.",
      components: [buildLinkButtonRow("Verificar status", STATUS_PAGE_URL)],
    },
  };
}

async function sendPayloadsWithV2Fallback(interaction, payloads) {
  const v2Payload = {
    ...payloads.v2,
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };

  try {
    await interaction.deleteReply().catch(() => null);
    await interaction.followUp(v2Payload);
    return;
  } catch (error) {
    console.warn(
      "[verificar-plano] Components V2 indisponivel para esta resposta, aplicando fallback:",
      error?.message || error,
    );
  }

  const fallbackPayload = {
    ...payloads.fallback,
    flags: MessageFlags.Ephemeral,
  };

  try {
    await interaction.followUp(fallbackPayload);
  } catch {
    await interaction.editReply(payloads.fallback).catch(() => null);
  }
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
      const payloads = snapshot?.hasPlan
        ? buildPlanPayloads(snapshot)
        : buildNoPlanPayloads();

      await sendPayloadsWithV2Fallback(interaction, payloads);
    } catch (error) {
      console.error("[verificar-plano] Falha ao consultar plano da conta:", error);
      await sendPayloadsWithV2Fallback(interaction, buildErrorPayloads());
    }
  },
};
