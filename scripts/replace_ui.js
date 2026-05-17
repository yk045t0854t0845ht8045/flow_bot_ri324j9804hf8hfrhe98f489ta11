const fs = require('fs');

let content = fs.readFileSync('site/components/servers/ServerSettingsEditor.tsx', 'utf8');

content = content.replace(
  'import { serversScale } from "@/components/servers/serversScale";',
  'import { serversScale } from "@/components/servers/serversScale";\nimport { ServerSectionHeading, ServerSurface } from "@/components/servers/ServerUi";'
);

content = content.replace(
  /\) : settingsSection === "ticket_ai" \? \(\r?\n\s+<div className="space-y-\[14px\]">\r?\n\s+<div className="rounded-\[24px\] border border-\[#161616\] bg-\[linear-gradient\(180deg,#0B0B0B_0%,#090909_100%\)\] px-\[18px\] py-\[18px\] sm:px-\[22px\] sm:py-\[22px\]">\r?\n\s+<div className="flex flex-col gap-\[14px\] lg:flex-row lg:items-center lg:justify-between">\r?\n\s+<div className="min-w-0">\r?\n\s+<div className="inline-flex items-center gap-\[6px\] rounded-full border border-\[rgba\(0,98,255,0.18\)\] bg-\[rgba\(0,98,255,0.06\)\] px-\[10px\] py-\[5px\] text-\[10px\] font-bold uppercase tracking-\[0.16em\] text-\[#4A93FF\]">\r?\n\s+Inteligencia Artificial\r?\n\s+<\/div>\r?\n\s+<h3 className="mt-\[14px\] text-\[26px\] leading-tight font-medium tracking-\[-0.04em\] text-\[#D1D1D1\]">\r?\n\s+Otimize seu atendimento com FlowAI\r?\n\s+<\/h3>\r?\n\s+<p className="mt-\[10px\] max-w-\[760px\] text-\[14px\] leading-\[1.62\] text-\[#7B7B7B\]">\r?\n\s+Personalize a forma como a IA entende sua empresa e as regras de atendimento para sugestoes proativas e precisas.\r?\n\s+<\/p>\r?\n\s+<p className="mt-\[12px\] text-\[12px\] uppercase tracking-\[0.14em\] text-\[#5B5B5B\]">\r?\n\s+\{flowAiHeaderDescription\}\r?\n\s+<\/p>\r?\n\s+<\/div>\r?\n\s+<div className="shrink-0">\r?\n\s+<div className="flex items-center">\r?\n\s+<DashboardInlineSwitch\r?\n\s+checked=\{aiEnabled\}\r?\n\s+onChange=\{\(\) => \{\r?\n\s+if \(isSaving \|\| settingsReadOnly\) return;\r?\n\s+if \(aiEnabled\) \{\r?\n\s+setHasPendingFlowAiActivationRequest\(false\);\r?\n\s+setAiEnabled\(false\);\r?\n\s+return;\r?\n\s+\}\r?\n\s+setErrorMessage\(null\);\r?\n\s+if \(resolvedFlowAiPlanCode\) \{\r?\n\s+setHasPendingFlowAiActivationRequest\(false\);\r?\n\s+if \(!isFlowAiEligiblePlanCode\(resolvedFlowAiPlanCode\)\) \{\r?\n\s+setIsFlowAiUpgradeModalOpen\(true\);\r?\n\s+return;\r?\n\s+\}\r?\n\s+setAiEnabled\(true\);\r?\n\s+return;\r?\n\s+\}\r?\n\s+if \(!isFlowAiPlanLoading && hasFlowAiPlanCheckError\) \{\r?\n\s+setErrorMessage\(\r?\n\s+"Nao foi possivel verificar o plano agora. Tente novamente em alguns instantes.",\r?\n\s+\);\r?\n\s+return;\r?\n\s+\}\r?\n\s+setHasPendingFlowAiActivationRequest\(true\);\r?\n\s+\}\}\r?\n\s+disabled=\{\r?\n\s+isSaving \|\|\r?\n\s+settingsReadOnly \|\|\r?\n\s+hasPendingFlowAiActivationRequest\r?\n\s+\}\r?\n\s+ariaLabel="Ativar ou desativar modulo FlowAI"\r?\n\s+\/>\r?\n\s+<\/div>\r?\n\s+<\/div>\r?\n\s+<\/div>\r?\n\s+<\/div>/,
  `) : settingsSection === "ticket_ai" ? (
                    <div className="space-y-[18px]">
                      <ServerSectionHeading
                        eyebrow="Inteligencia Artificial"
                        title="Otimize seu atendimento com FlowAI"
                        description="Personalize a forma como a IA entende sua empresa e as regras de atendimento para sugestoes proativas e precisas."
                        action={
                          <div className="flex items-center gap-[10px] sm:gap-[16px]">
                            <p className="hidden text-[12px] uppercase tracking-[0.14em] text-[#5B5B5B] sm:block">
                              {flowAiHeaderDescription}
                            </p>
                            <DashboardInlineSwitch
                              checked={aiEnabled}
                              onChange={() => {
                                if (isSaving || settingsReadOnly) return;
                                if (aiEnabled) {
                                  setHasPendingFlowAiActivationRequest(false);
                                  setAiEnabled(false);
                                  return;
                                }

                                setErrorMessage(null);

                                if (resolvedFlowAiPlanCode) {
                                  setHasPendingFlowAiActivationRequest(false);

                                  if (!isFlowAiEligiblePlanCode(resolvedFlowAiPlanCode)) {
                                    setIsFlowAiUpgradeModalOpen(true);
                                    return;
                                  }

                                  setAiEnabled(true);
                                  return;
                                }

                                if (!isFlowAiPlanLoading && hasFlowAiPlanCheckError) {
                                  setErrorMessage(
                                    "Nao foi possivel verificar o plano agora. Tente novamente em alguns instantes.",
                                  );
                                  return;
                                }

                                setHasPendingFlowAiActivationRequest(true);
                              }}
                              disabled={
                                isSaving ||
                                settingsReadOnly ||
                                hasPendingFlowAiActivationRequest
                              }
                              ariaLabel="Ativar ou desativar modulo FlowAI"
                            />
                          </div>
                        }
                      />`
);

content = content.replace(
  '<div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">\n                          <div>\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Identidade da Empresa</p>',
  '<ServerSurface className="p-[18px] sm:p-[22px]">\n                          <div>\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Identidade da Empresa</p>'
);

content = content.replace(
  '<div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">\r\n                          <div>\r\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Identidade da Empresa</p>',
  '<ServerSurface className="p-[18px] sm:p-[22px]">\r\n                          <div>\r\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Identidade da Empresa</p>'
);

content = content.replace(
  '<div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">\n                          <div className="flex items-center gap-[6px]">\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Personalizacao FlowAI</p>',
  '<ServerSurface className="p-[18px] sm:p-[22px]">\n                          <div className="flex items-center gap-[6px]">\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Personalizacao FlowAI</p>'
);

content = content.replace(
  '<div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">\r\n                          <div className="flex items-center gap-[6px]">\r\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Personalizacao FlowAI</p>',
  '<ServerSurface className="p-[18px] sm:p-[22px]">\r\n                          <div className="flex items-center gap-[6px]">\r\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Personalizacao FlowAI</p>'
);

content = content.replace(
  '</div>\n                        </div>\n                      </div>\n\n                      <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">\n                        <div className="flex flex-col gap-[10px] lg:flex-row lg:items-start lg:justify-between">\n                          <div>\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Processamento de Reembolso</p>',
  '</ServerSurface>\n                      </div>\n\n                      <ServerSurface className="p-[18px] sm:p-[22px]">\n                        <div className="flex flex-col gap-[10px] lg:flex-row lg:items-start lg:justify-between">\n                          <div>\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Processamento de Reembolso</p>'
);

content = content.replace(
  '</div>\r\n                        </div>\r\n                      </div>\r\n\r\n                      <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">\r\n                        <div className="flex flex-col gap-[10px] lg:flex-row lg:items-start lg:justify-between">\r\n                          <div>\r\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Processamento de Reembolso</p>',
  '</ServerSurface>\r\n                      </div>\r\n\r\n                      <ServerSurface className="p-[18px] sm:p-[22px]">\r\n                        <div className="flex flex-col gap-[10px] lg:flex-row lg:items-start lg:justify-between">\r\n                          <div>\r\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Processamento de Reembolso</p>'
);

content = content.replace(
  '                      </div>\n                    </div>\n                  ) : null}',
  '                      </ServerSurface>\n                    </div>\n                  ) : null}'
);

content = content.replace(
  '                      </div>\r\n                    </div>\r\n                  ) : null}',
  '                      </ServerSurface>\r\n                    </div>\r\n                  ) : null}'
);

fs.writeFileSync('site/components/servers/ServerSettingsEditor.tsx', content);
console.log('Script executed.');
