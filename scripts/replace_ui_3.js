const fs = require('fs');
let content = fs.readFileSync('site/components/servers/ServerSettingsEditor.tsx', 'utf8');

// 1. Add imports
content = content.replace(
  'import { serversScale } from "@/components/servers/serversScale";',
  'import { serversScale } from "@/components/servers/serversScale";\nimport { ServerSectionHeading, ServerSurface } from "@/components/servers/ServerUi";'
);

// 2. Replace the top banner with ServerSectionHeading
const topBannerOld = `                  ) : settingsSection === "ticket_ai" ? (
                    <div className="space-y-[14px]">
                      <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">
                        <div className="flex flex-col gap-[14px] lg:flex-row lg:items-center lg:justify-between">
                          <div className="min-w-0">
                            <div className="inline-flex items-center gap-[6px] rounded-full border border-[rgba(0,98,255,0.18)] bg-[rgba(0,98,255,0.06)] px-[10px] py-[5px] text-[10px] font-bold uppercase tracking-[0.16em] text-[#4A93FF]">
                              Inteligencia Artificial
                            </div>
                            <h3 className="mt-[14px] text-[26px] leading-tight font-medium tracking-[-0.04em] text-[#D1D1D1]">
                              Otimize seu atendimento com FlowAI
                            </h3>
                            <p className="mt-[10px] max-w-[760px] text-[14px] leading-[1.62] text-[#7B7B7B]">
                              Personalize a forma como a IA entende sua empresa e as regras de atendimento para sugestoes proativas e precisas.
                            </p>
                            <p className="mt-[12px] text-[12px] uppercase tracking-[0.14em] text-[#5B5B5B]">
                              {flowAiHeaderDescription}
                            </p>
                          </div>
                          
                          <div className="shrink-0">
                            <div className="flex items-center">
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
                          </div>
                        </div>
                      </div>`;

const topBannerNew = `                  ) : settingsSection === "ticket_ai" ? (
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
                      />`;
                      
content = content.replace(topBannerOld, topBannerNew);
content = content.replace(topBannerOld.replace(/\n/g, '\r\n'), topBannerNew);

// 3. Replace the three configuration blocks with ServerSurface
// It is easier to use regex to replace `<div className="rounded-[24px]...` with `<ServerSurface className="p-[18px] sm:p-[22px]">`
// ONLY for the specific lines that correspond to FlowAI section.

// "Identidade da Empresa" div
const idEmpresaOld = `<div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">
                          <div>
                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Identidade da Empresa</p>`;
const idEmpresaNew = `<ServerSurface className="p-[18px] sm:p-[22px]">
                          <div>
                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Identidade da Empresa</p>`;
content = content.replace(idEmpresaOld, idEmpresaNew);
content = content.replace(idEmpresaOld.replace(/\n/g, '\r\n'), idEmpresaNew);

// End of Identidade / Start of Personalizacao
const persFlowAIOld = `                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">
                          <div>
                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Personalizacao FlowAI</p>`;
const persFlowAINew = `                              </div>
                            </div>
                          </div>
                        </ServerSurface>

                        <ServerSurface className="p-[18px] sm:p-[22px]">
                          <div>
                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Personalizacao FlowAI</p>`;
content = content.replace(persFlowAIOld, persFlowAINew);
content = content.replace(persFlowAIOld.replace(/\n/g, '\r\n'), persFlowAINew);

// End of Personalizacao / Start of Reembolso
const reembFlowAIOld = `                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">
                        <div className="flex flex-col gap-[10px] lg:flex-row lg:items-start lg:justify-between">
                          <div>
                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Processamento de Reembolso</p>`;
const reembFlowAINew = `                              </div>
                            </div>
                          </div>
                        </ServerSurface>
                      </div>

                      <ServerSurface className="p-[18px] sm:p-[22px]">
                        <div className="flex flex-col gap-[10px] lg:flex-row lg:items-start lg:justify-between">
                          <div>
                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Processamento de Reembolso</p>`;
content = content.replace(reembFlowAIOld, reembFlowAINew);
content = content.replace(reembFlowAIOld.replace(/\n/g, '\r\n'), reembFlowAINew);

// End of Reembolso
const endFlowAIOld = `                              className={\`h-[44px] w-full rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] text-[14px] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] \${aiControlsDisabled ? "cursor-not-allowed opacity-50" : ""}\`}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : settingsSection === "message" ? (`
const endFlowAINew = `                              className={\`h-[44px] w-full rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] text-[14px] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] \${aiControlsDisabled ? "cursor-not-allowed opacity-50" : ""}\`}
                            />
                          </div>
                        </div>
                      </ServerSurface>
                    </div>
                  ) : settingsSection === "message" ? (`
content = content.replace(endFlowAIOld, endFlowAINew);
content = content.replace(endFlowAIOld.replace(/\n/g, '\r\n'), endFlowAINew);

fs.writeFileSync('site/components/servers/ServerSettingsEditor.tsx', content);
console.log('Script executed.');
