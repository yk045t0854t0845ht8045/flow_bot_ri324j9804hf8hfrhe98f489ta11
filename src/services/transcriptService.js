const discordTranscripts = require("discord-html-transcripts");

async function generateTranscriptHtml(channel) {
  const transcriptHtml = await discordTranscripts.createTranscript(channel, {
    returnType: "string",
    saveImages: true,
    poweredBy: false,
    footerText: "Transcript gerado automaticamente.",
  });

  return String(transcriptHtml || "");
}

module.exports = { generateTranscriptHtml };
