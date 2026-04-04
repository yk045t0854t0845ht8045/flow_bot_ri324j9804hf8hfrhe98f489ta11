const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} = require("discord.js");
const { env } = require("../config/env");

function buildOfficialLinkComponents() {
  return [
    new ContainerBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "## <:flowdesk:1485080957592797315> Vincule sua conta com o Discord",
        ),
      )
      .addSectionComponents(
        new SectionBuilder()
          .setButtonAccessory(
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setLabel("Termos de Uso")
              .setURL(env.officialTermsUrl),
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "-# Conecte sua conta do Discord a plataforma para sincronizar com seguranca seu acesso ao Flowdesk, liberar recursos automaticamente e manter a verificacao da conta sempre atualizada.\n-# Mesmo quem ainda nao e cliente pode vincular a conta para preparar o acesso, acompanhar o servidor oficial e manter a identidade conectada ao sistema.",
            ),
          ),
      )
      .addSectionComponents(
        new SectionBuilder()
          .setButtonAccessory(
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setLabel("Politica de Privacidade")
              .setURL(env.officialPrivacyUrl),
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "-# Depois da vinculacao, o Flowdesk sincroniza sua conta em tempo real e libera automaticamente o cargo oficial de acesso vinculado.",
            ),
          ),
      )
      .addSeparatorComponents(
        new SeparatorBuilder()
          .setSpacing(SeparatorSpacingSize.Large)
          .setDivider(true),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### Como liberar o acesso?\n\n-# Clique em [Vincular minha conta com Discord](${env.officialAccountLinkUrl}), faca login no Flowdesk com sua conta do Discord e aguarde a sincronizacao segura.\n-# Se a conta ja estiver autenticada, o sistema conclui a vinculacao automaticamente e aplica o cargo oficial no servidor.\n-# Depois disso, basta voltar ao Discord. Caso algo nao sincronize na hora, repita o processo para forcar uma nova verificacao.\n`,
        ),
      )
      .addSeparatorComponents(
        new SeparatorBuilder()
          .setSpacing(SeparatorSpacingSize.Large)
          .setDivider(true),
      )
      .addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL("https://imgur.com/Ii1Clim.png"),
        ),
        
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# <:flowdesk_icon:1485070577982116000> Todos os direitos reservados (c) 2026 Flowdesk. Ao vincular-se, voce concorda com nossos [Termos de Servico](${env.officialTermsUrl}) e [Politica de Privacidade](${env.officialPrivacyUrl}).`,
        ),
      ),
    new SeparatorBuilder()
      .setSpacing(SeparatorSpacingSize.Large)
      .setDivider(true),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Vincular minha conta")
        .setURL(env.officialAccountLinkUrl),
    ),
  ];
}

function walkComponents(components, visitor) {
  if (!Array.isArray(components)) return;

  for (const component of components) {
    if (!component) continue;
    visitor(component);

    if (Array.isArray(component.components) && component.components.length) {
      walkComponents(component.components, visitor);
    }
  }
}

function messageLooksLikeOfficialLinkPanel(message) {
  if (!message || !message.author || message.author.bot !== true) {
    return false;
  }

  if (message.author.id !== message.client.user.id) {
    return false;
  }

  let foundMatchingButton = false;
  walkComponents(message.components, (component) => {
    const label = component.label || component.data?.label;
    const url = component.url || component.data?.url;

    if (
      label === "Vincular minha conta" &&
      typeof url === "string" &&
      url === env.officialAccountLinkUrl
    ) {
      foundMatchingButton = true;
    }
  });

  return foundMatchingButton;
}

async function fetchExistingPanelMessage(channel) {
  const recentMessages = await channel.messages.fetch({ limit: 25 });
  const matchingMessage = recentMessages.find((message) =>
    messageLooksLikeOfficialLinkPanel(message),
  );

  if (matchingMessage) {
    return matchingMessage;
  }

  return (
    recentMessages.find(
      (message) =>
        message.author?.id === channel.client.user.id &&
        message.author?.bot === true,
    ) || null
  );
}

async function ensureOfficialLinkPanel(client) {
  const channel = await client.channels.fetch(env.officialLinkChannelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error(
      `Canal oficial de vinculacao ${env.officialLinkChannelId} nao foi encontrado ou nao aceita mensagens.`,
    );
  }

  if (channel.guildId !== env.officialSupportGuildId) {
    throw new Error(
      `O canal ${env.officialLinkChannelId} nao pertence ao servidor oficial ${env.officialSupportGuildId}.`,
    );
  }

  const payload = {
    flags: MessageFlags.IsComponentsV2,
    components: buildOfficialLinkComponents(),
  };

  const existingMessage = await fetchExistingPanelMessage(channel);

  if (existingMessage) {
    await existingMessage.edit(payload);
    return { mode: "updated", messageId: existingMessage.id };
  }

  const sentMessage = await channel.send(payload);
  return { mode: "created", messageId: sentMessage.id };
}

module.exports = {
  ensureOfficialLinkPanel,
};
