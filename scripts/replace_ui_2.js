const fs = require('fs');

let content = fs.readFileSync('site/components/servers/ServerSettingsEditor.tsx', 'utf8');

content = content.replace(
  '                          </div>\r\n                        </div>\r\n\r\n                        <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">\r\n                          <div>\r\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Personalizacao FlowAI</p>',
  '                          </div>\r\n                        </ServerSurface>\r\n\r\n                        <ServerSurface className="p-[18px] sm:p-[22px]">\r\n                          <div>\r\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Personalizacao FlowAI</p>'
);

content = content.replace(
  '                          </div>\n                        </div>\n\n                        <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">\n                          <div>\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Personalizacao FlowAI</p>',
  '                          </div>\n                        </ServerSurface>\n\n                        <ServerSurface className="p-[18px] sm:p-[22px]">\n                          <div>\n                            <p className="text-[12px] uppercase tracking-[0.18em] text-[#5F5F5F]">Personalizacao FlowAI</p>'
);

content = content.replace(
  '                              </div>\r\n                            </div>\r\n                          </div>\r\n                        </div>\r\n                      </div>\r\n\r\n                      <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">\r\n                        <div className="flex flex-col gap-[10px] lg:flex-row lg:items-start lg:justify-between">',
  '                              </div>\r\n                            </div>\r\n                          </div>\r\n                        </ServerSurface>\r\n                      </div>\r\n\r\n                      <ServerSurface className="p-[18px] sm:p-[22px]">\r\n                        <div className="flex flex-col gap-[10px] lg:flex-row lg:items-start lg:justify-between">'
);

content = content.replace(
  '                              </div>\n                            </div>\n                          </div>\n                        </div>\n                      </div>\n\n                      <div className="rounded-[24px] border border-[#161616] bg-[linear-gradient(180deg,#0B0B0B_0%,#090909_100%)] px-[18px] py-[18px] sm:px-[22px] sm:py-[22px]">\n                        <div className="flex flex-col gap-[10px] lg:flex-row lg:items-start lg:justify-between">',
  '                              </div>\n                            </div>\n                          </div>\n                        </ServerSurface>\n                      </div>\n\n                      <ServerSurface className="p-[18px] sm:p-[22px]">\n                        <div className="flex flex-col gap-[10px] lg:flex-row lg:items-start lg:justify-between">'
);

content = content.replace(
  '                              className={`h-[44px] w-full rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] text-[14px] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] ${aiControlsDisabled ? "cursor-not-allowed opacity-50" : ""}`}\r\n                            />\r\n                          </div>\r\n                        </div>\r\n                      </div>\r\n                    </div>\r\n                  ) : settingsSection === "message" ? (',
  '                              className={`h-[44px] w-full rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] text-[14px] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] ${aiControlsDisabled ? "cursor-not-allowed opacity-50" : ""}`}\r\n                            />\r\n                          </div>\r\n                        </div>\r\n                      </ServerSurface>\r\n                    </div>\r\n                  ) : settingsSection === "message" ? ('
);

content = content.replace(
  '                              className={`h-[44px] w-full rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] text-[14px] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] ${aiControlsDisabled ? "cursor-not-allowed opacity-50" : ""}`}\n                            />\n                          </div>\n                        </div>\n                      </div>\n                    </div>\n                  ) : settingsSection === "message" ? (',
  '                              className={`h-[44px] w-full rounded-[14px] border border-[#171717] bg-[#080808] px-[14px] text-[14px] text-[#D1D1D1] outline-none transition-all placeholder:text-[#3B3B3B] focus:border-[#262626] ${aiControlsDisabled ? "cursor-not-allowed opacity-50" : ""}`}\n                            />\n                          </div>\n                        </div>\n                      </ServerSurface>\n                    </div>\n                  ) : settingsSection === "message" ? ('
);

fs.writeFileSync('site/components/servers/ServerSettingsEditor.tsx', content);
console.log('Script executed.');
