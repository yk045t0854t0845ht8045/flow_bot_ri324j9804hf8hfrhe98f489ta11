const fs = require('fs');
let content = fs.readFileSync('site/components/servers/ServerSettingsEditor.tsx', 'utf8');

// Find the start marker
const startMarker = ') : settingsSection === "ticket_ai" ? (';
const endMarker = ') : settingsSection === "message" ? (';

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.error('Markers not found!', startIdx, endIdx);
  process.exit(1);
}

const newSection = `) : settingsSection === "ticket_ai" ? (
                    <div className="space-y-[14px]">
                      <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">
                        <div className="flex flex-col gap-[14px] lg:flex-row lg:items-center lg:justify-between">
                          <div>
                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">
                              Modulo FlowAI
                            </p>
                            <h3 className="mt-[10px] text-[22px] leading-none font-medium tracking-[-0.04em] text-[#D1D1D1]">
                              Otimize seu atendimento com IA
                            </h3>
                            <p className="mt-[10px] max-w-[760px] text-[14px] leading-[1.6] text-[#7B7B7B]">
                              O FlowAI entende sua empresa, aplica suas regras e conduz reembolsos de forma segura quando o modulo estiver ativo.
                            </p>
                            <p className="mt-[10px] text-[12px] uppercase tracking-[0.14em] text-[#5B5B5B]">
                              {flowAiHeaderDescription}
                            </p>
                          </div>

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

                      <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2 xl:grid-cols-4">
                        {flowAiChecklist.map((item) => (
                          <div
                            key={item.id}
                            className={\`rounded-[20px] border px-[16px] py-[14px] \${
                              item.complete
                                ? "border-[rgba(0,98,255,0.2)] bg-[rgba(0,98,255,0.06)]"
                                : "border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)]"
                            }\`}
                          >
                            <p className="text-[11px] uppercase tracking-[0.16em] text-[#5F5F5F]">
                              {item.label}
                            </p>
                            <p
                              className={\`mt-[10px] text-[16px] font-medium tracking-[-0.02em] \${
                                item.complete ? "text-[#D7E6FF]" : "text-[#D1D1D1]"
                              }\`}
                            >
                              {item.value}
                            </p>
                          </div>
                        ))}
                      </div>

                      <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">
                        <div>
                          <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Identidade da Empresa</p>
                          <h3 className="mt-[10px] text-[22px] leading-none font-medium tracking-[-0.04em] text-[#D1D1D1]">
                            Como a IA ve seu negocio
                          </h3>
                          <p className="mt-[10px] max-w-[760px] text-[14px] leading-[1.6] text-[#7B7B7B]">
                            Defina o nome e o objetivo principal para que a IA se comporte como um membro da sua equipe.
                          </p>
                        </div>

                        <div className="mt-[18px] grid grid-cols-1 gap-[16px] xl:grid-cols-2">
                          <div>
                            <label className="mb-[8px] block text-[12px] font-medium text-[#5F5F5F]">Nome da Empresa / Marca</label>
                            <input
                              type="text"
                              value={aiCompanyName}
                              onChange={(e) => setAiCompanyName(e.target.value)}
                              placeholder="Ex: Flowdesk, Loja do Anderson..."
                              maxLength={100}
                              disabled={aiControlsDisabled}
                              className="h-[48px] w-full rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] text-[14px] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <div className="mt-[6px] flex justify-end">
                              <span className={\`text-[10px] font-medium tracking-wide \${aiCompanyName.length >= 100 ? "text-[#FF4A4A]" : "text-[#404040]"}\`}>
                                {aiCompanyName.length}/100
                              </span>
                            </div>
                          </div>
                          <div>
                            <label className="mb-[8px] block text-[12px] font-medium text-[#5F5F5F]">Descricao do que vendem / fazem</label>
                            <textarea
                              rows={3}
                              value={aiCompanyBio}
                              onChange={(e) => setAiCompanyBio(e.target.value)}
                              placeholder="Somos uma empresa focada em automacao para Discord..."
                              maxLength={1000}
                              disabled={aiControlsDisabled}
                              className="min-h-[92px] w-full resize-none rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] py-[12px] text-[14px] leading-[1.5] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <div className="mt-[6px] flex justify-end">
                              <span className={\`text-[10px] font-medium tracking-wide \${aiCompanyBio.length >= 1000 ? "text-[#FF4A4A]" : "text-[#404040]"}\`}>
                                {aiCompanyBio.length}/1000
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">
                        <div>
                          <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Personalizacao FlowAI</p>
                          <h3 className="mt-[10px] text-[22px] leading-none font-medium tracking-[-0.04em] text-[#D1D1D1]">
                            Regras e Tom de Voz
                          </h3>
                          <p className="mt-[10px] max-w-[760px] text-[14px] leading-[1.6] text-[#7B7B7B]">
                            Configure as diretrizes e como a IA deve se comunicar com seus clientes no dia a dia.
                          </p>
                        </div>

                        <div className="mt-[18px] space-y-[16px]">
                          <div>
                            <p className="mb-[10px] text-[12px] font-medium text-[#5F5F5F]">Modelos rapidos</p>
                            <div className="grid grid-cols-1 gap-[8px] sm:grid-cols-3">
                              {FLOW_AI_RULE_PRESETS.map((preset) => (
                                <button
                                  key={preset.id}
                                  type="button"
                                  onClick={() => {
                                    if (aiControlsDisabled) return;
                                    setAiRulesDraft(preset.rules);
                                    setIsAiRulesModalOpen(true);
                                  }}
                                  disabled={aiControlsDisabled}
                                  className={\`rounded-[16px] border px-[12px] py-[12px] text-left transition-all \${
                                    aiControlsDisabled
                                      ? "cursor-not-allowed border-[#171717] bg-[#090909] opacity-40"
                                      : "border-[#171717] bg-[#090909] hover:border-[#232323] hover:bg-[#0C0C0C]"
                                  }\`}
                                >
                                  <span className="block text-[13px] font-medium text-[#D1D1D1]">
                                    {preset.label}
                                  </span>
                                  <span className="mt-[5px] block text-[11px] leading-[1.5] text-[#5A5A5A]">
                                    {preset.description}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              if (aiControlsDisabled) return;
                              setAiRulesDraft(aiRules);
                              setIsAiRulesModalOpen(true);
                            }}
                            disabled={aiControlsDisabled}
                            className={\`group relative flex w-full items-center justify-between gap-[16px] rounded-[18px] border border-[#1A1A1A] bg-[#0A0A0A] p-[4px] pr-[14px] transition-all \${
                              aiControlsDisabled
                                ? "cursor-not-allowed opacity-40 grayscale-[0.5]"
                                : "hover:border-[#222222] hover:bg-[#0D0D0D]"
                            }\`}
                          >
                            <div className="flex items-center gap-[12px]">
                              <span className="flex h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-[#1C1C1C] bg-[#0E0E0E] text-[#6D6D6D] group-hover:text-[#A1A1A1]">
                                <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 5h14M3 10h14M3 15h10" strokeLinecap="round"/></svg>
                              </span>
                              <div className="text-left">
                                <span className="block text-[14px] font-medium text-[#D1D1D1]">
                                  {flowAiRulesCount ? "Editar Diretrizes" : "Criar Regras"}
                                </span>
                                <span className="block text-[11px] text-[#5A5A5A]">
                                  {flowAiRulesCount
                                    ? \`\${flowAiRulesCount} caracteres configurados\`
                                    : "Defina diretrizes de atendimento"}
                                </span>
                              </div>
                            </div>
                            <span className="text-[#454545] transition-transform group-hover:translate-x-[2px]"><svg viewBox="0 0 20 20" className="h-[14px] w-[14px]" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M7.5 15l5-5-5-5" strokeLinecap="round" strokeLinejoin="round"/></svg></span>
                          </button>

                          <div className="rounded-[18px] border border-[#171717] bg-[#090909] px-[14px] py-[12px]">
                            <p className="text-[11px] uppercase tracking-[0.16em] text-[#5F5F5F]">Resumo atual</p>
                            <p className="mt-[8px] text-[13px] leading-[1.6] text-[#767676]">
                              {flowAiRulesCount
                                ? aiRules.trim().slice(0, 180)
                                : "Nenhuma diretriz salva ainda. Use um modelo rapido ou escreva suas regras manuais."}
                              {flowAiRulesCount > 180 ? "..." : ""}
                            </p>
                          </div>

                          <div className="grid grid-cols-2 gap-[10px]">
                            {[
                              { id: "formal", label: "Profissional", icon: "🏢" },
                              { id: "friendly", label: "Amigavel", icon: "✨" },
                            ].map((tone) => (
                              <button
                                key={tone.id}
                                type="button"
                                onClick={() => {
                                  if (aiControlsDisabled) return;
                                  setAiTone(tone.id);
                                }}
                                disabled={aiControlsDisabled}
                                className={\`flex flex-col items-center justify-center gap-[8px] rounded-[18px] border py-[16px] transition-all \${
                                  aiControlsDisabled ? "opacity-40 cursor-not-allowed grayscale-[0.5]" : ""
                                } \${
                                  aiTone === tone.id
                                    ? "border-[#4A93FF] bg-[rgba(0,98,255,0.06)] shadow-[0_0_12px_rgba(0,98,255,0.12)]"
                                    : aiControlsDisabled ? "border-[#171717] bg-[#090909]" : "border-[#171717] bg-[#090909] hover:border-[#1E1E1E] hover:bg-[#0B0B0B]"
                                }\`}
                              >
                                <span className={\`text-[20px] transition-transform \${aiTone === tone.id ? "scale-110" : ""}\`}>{tone.icon}</span>
                                <span className={\`text-[12px] font-medium transition-colors \${aiTone === tone.id ? "text-[#4A93FF]" : "text-[#8A8A8A]"}\`}>{tone.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">
                        <div className="flex flex-col gap-[12px] lg:flex-row lg:items-end lg:justify-between">
                          <div>
                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Processamento de Reembolso</p>
                            <h3 className="mt-[10px] text-[22px] leading-none font-medium tracking-[-0.04em] text-[#D1D1D1]">
                              Regras financeiras do atendimento
                            </h3>
                            <p className="mt-[10px] max-w-[760px] text-[14px] leading-[1.6] text-[#7B7B7B]">
                              Defina como o FlowAI consulta compras, valida prazo e encaminha aprovacoes sem expor credenciais no Discord.
                            </p>
                          </div>
                        </div>

                        <div className="mt-[18px] grid grid-cols-1 gap-[16px] xl:grid-cols-2">
                          <div>
                            <label className="mb-[8px] block text-[12px] font-medium text-[#5F5F5F]">Prazo limite para reembolso (dias)</label>
                            <input
                              type="number"
                              min={0}
                              max={365}
                              value={refundLimitDays}
                              onChange={(event) => setRefundLimitDays(Math.max(0, Math.min(365, Number(event.target.value || 0))))}
                              disabled={aiControlsDisabled}
                              className="h-[48px] w-full rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] text-[14px] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] disabled:cursor-not-allowed disabled:opacity-60"
                            />
                          </div>
                          <ConfigStepSelect
                            label="Canal de aprovacao manual"
                            placeholder="Escolha o canal"
                            options={textChannelOptions}
                            value={refundApprovalChannelId}
                            onChange={setRefundApprovalChannelId}
                            disabled={aiControlsDisabled}
                            controlHeightPx={serverSettingsControlHeight}
                          />
                          <ConfigStepMultiSelect
                            label="Cargos que aprovam ou negam"
                            placeholder="Escolha os cargos"
                            options={roleOptions}
                            values={refundApproverRoleIds}
                            onChange={setRefundApproverRoleIds}
                            disabled={aiControlsDisabled}
                            controlHeightPx={serverSettingsControlHeight}
                          />
                          <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2">
                            <label className={\`flex items-center justify-between gap-[12px] rounded-[16px] border border-[#171717] bg-[#090909] px-[14px] py-[12px] \${aiControlsDisabled ? "cursor-not-allowed opacity-60" : ""}\`}>
                              <span className="text-[12px] font-medium text-[#8A8A8A]">Processar automatico</span>
                              <input
                                type="checkbox"
                                checked={refundAutoProcessEnabled}
                                onChange={(event) => setRefundAutoProcessEnabled(event.target.checked)}
                                disabled={aiControlsDisabled}
                              />
                            </label>
                            <label className={\`flex items-center justify-between gap-[12px] rounded-[16px] border border-[#171717] bg-[#090909] px-[14px] py-[12px] \${aiControlsDisabled ? "cursor-not-allowed opacity-60" : ""}\`}>
                              <span className="text-[12px] font-medium text-[#8A8A8A]">Exigir aprovacao manual</span>
                              <input
                                type="checkbox"
                                checked={refundManualApprovalRequired}
                                onChange={(event) => setRefundManualApprovalRequired(event.target.checked)}
                                disabled={aiControlsDisabled}
                              />
                            </label>
                          </div>
                        </div>

                        <div className="mt-[16px] grid grid-cols-1 gap-[16px] xl:grid-cols-2">
                          <div className="xl:col-span-2">
                            <label className="mb-[8px] block text-[12px] font-medium text-[#5F5F5F]">Regras e condicoes do reembolso</label>
                            <textarea
                              rows={4}
                              value={refundRules}
                              onChange={(event) => setRefundRules(event.target.value)}
                              placeholder="Ex: Reembolso disponivel em ate 7 dias apos a compra. Produtos digitais nao sao reembolsaveis..."
                              maxLength={2000}
                              disabled={aiControlsDisabled}
                              className="min-h-[100px] w-full resize-none rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] py-[12px] text-[14px] leading-[1.5] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] disabled:cursor-not-allowed disabled:opacity-60"
                            />
                          </div>
                          <div>
                            <label className="mb-[8px] block text-[12px] font-medium text-[#5F5F5F]">Mensagem de sucesso personalizada</label>
                            <input
                              type="text"
                              value={refundSuccessMessage}
                              onChange={(event) => setRefundSuccessMessage(event.target.value)}
                              placeholder="Ex: Reembolso aprovado! O valor sera estornado em ate 5 dias uteis."
                              maxLength={600}
                              disabled={aiControlsDisabled}
                              className="h-[48px] w-full rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] text-[14px] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] disabled:cursor-not-allowed disabled:opacity-60"
                            />
                          </div>
                          <div>
                            <label className="mb-[8px] block text-[12px] font-medium text-[#5F5F5F]">Mensagem de erro personalizada</label>
                            <input
                              type="text"
                              value={refundErrorMessage}
                              onChange={(event) => setRefundErrorMessage(event.target.value)}
                              placeholder="Ex: Nao foi possivel processar o reembolso. Entre em contato com o suporte."
                              maxLength={600}
                              disabled={aiControlsDisabled}
                              className="h-[48px] w-full rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] text-[14px] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] disabled:cursor-not-allowed disabled:opacity-60"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  `;

// Remove the old ServerSectionHeading import since it may not be needed anymore (ServerSurface also gone)
// We keep the import in case other parts of the file use it - let lint decide.

const before = content.slice(0, startIdx);
const after = content.slice(endIdx);

const newContent = before + newSection + after;
fs.writeFileSync('site/components/servers/ServerSettingsEditor.tsx', newContent);
console.log('Done. Section replaced successfully.');
