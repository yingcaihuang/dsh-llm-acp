// dsh-llm-acp — "ACP 控制台": a report-style right-sidebar tab for every ACP CLI provider.
//
// Data: GET /api/llm-acp.dashboard (lib/dashboard-host.js). Writes are explicit clicks only:
// switch a provider or model on/off (plugin prefs file, applies at once) and re-read a CLI's models.
// Charts are plain SVG / CSS; containers use the host theme tokens, chart hues are artwork.
window.__ModuleLoader__.load({
  id: 'dsh-llm-acp',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Fragment, useCallback, useEffect, useRef, useState } = React

    const NS = 'llmAcp'
    const TAB_ID = 'dsh-llm-acp'
    const KIND = 'llm-acp-console'
    const PAGE_KEY = 'llm-acp-insights'
    const SLASH = 'acp'
    const R = {
      dashboard: 'api/llm-acp.dashboard', models: 'api/llm-acp.models', provider: 'api/llm-acp.provider',
      refresh: 'api/llm-acp.refresh', csv: 'api/llm-acp.csv',
      discover: 'api/llm-acp.discover', probe: 'api/llm-acp.probe', add: 'api/llm-acp.add', remove: 'api/llm-acp.remove', tps: 'api/llm-acp.tps',
    }
    const zh = { title: 'ACP 控制台', description: '查看已接入的 ACP CLI、运行状态、模型与 Token 用量报表，并控制哪些模型出现在模型列表里', open: '打开 ACP 控制台' }
    const en = { title: 'ACP console', description: 'Connected ACP CLIs, live status, models and token usage reports; choose which models appear in the model picker', open: 'Open ACP console' }
    const RANGES = [['today', '今日'], ['7', '7 天'], ['30', '30 天'], ['0', '全部']]
    const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#84cc16', '#f43f5e']
  const C_IN = '#6366f1'
  const C_OUT = '#10b981'
  const C_TIME = '#f59e0b'
  // Error classes for the insights view and weekly report. Order is the display order;
  // `test` matches an uppercased raw error code. The last entry is the catch-all.
  const ERROR_CLASSES = [
    { key: 'rate', label: '限流', color: '#f59e0b', test: (c) => /RATE|THROTTLE|TOO_MANY|429/.test(c) },
    { key: 'quota', label: '额度', color: '#8b5cf6', test: (c) => /QUOTA|CREDIT|INSUFFICIENT|BILLING/.test(c) },
    { key: 'auth', label: '认证', color: '#ec4899', test: (c) => /AUTH|UNAUTHOR|FORBIDDEN|LOGIN|401|403/.test(c) },
    { key: 'server', label: '服务端', color: '#dc2626', test: (c) => /SERVER|5\d\d|INTERNAL|BAD_GATEWAY|UNAVAILABLE|UPSTREAM|OVERLOAD/.test(c) },
    { key: 'timeout', label: '超时', color: '#0ea5e9', test: (c) => /TIMEOUT|TIMED_OUT|ETIMEDOUT|IDLE|STALE/.test(c) },
    { key: 'transport', label: '传输', color: '#14b8a6', test: (c) => /TRANSPORT|ECONN|CONNECTION|NETWORK|SOCKET|DISCONNECT/.test(c) },
  ]
  /** Map a raw error code to a friendly class (case-insensitive). */
  function errorClass(code) {
    const c = String(code ?? '').toUpperCase()
    for (const cls of ERROR_CLASSES) if (cls.test(c)) return cls
    return { key: 'other', label: '其他', color: '#94a3b8', test: null }
  }

    const CSS = `
.acp{container-type:inline-size;box-sizing:border-box;height:100%;overflow:auto;padding:14px 16px 40px;color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px;line-height:1.5;
--acp-card:var(--dsw-alias-bg-layer-1,#fff);--acp-sub:var(--dsw-alias-bg-layer-2,#f3f4f6);--acp-b1:var(--dsw-alias-border-l1,#eceef1);--acp-b2:var(--dsw-alias-border-l2,#e0e3e8);
--acp-fg:var(--dsw-alias-label-primary,#1f2328);--acp-muted:var(--dsw-alias-label-secondary,#6b7280);--acp-faint:var(--dsw-alias-label-tertiary,#9aa1ab);
--acp-ok:var(--dsw-alias-state-success-primary,#16a34a);--acp-warn:var(--dsw-alias-state-warn-primary,#d97706);--acp-err:var(--dsw-alias-state-error-primary,#dc2626);--acp-brand:var(--dsw-alias-state-business-primary,#4f46e5);
--acp-in:${C_IN};--acp-out:${C_OUT};--acp-time:${C_TIME};--acp-shadow:0 1px 2px rgba(15,23,42,.04),0 8px 22px -12px rgba(15,23,42,.14)}
.acp *{box-sizing:border-box}
.acp-hero{position:relative;border:1px solid var(--acp-b2);border-radius:14px;padding:14px 16px 12px;margin-bottom:12px;box-shadow:var(--acp-shadow);background:linear-gradient(118deg,color-mix(in srgb,var(--acp-in) 11%,transparent),transparent 48%,color-mix(in srgb,var(--acp-out) 10%,transparent)),var(--acp-card)}
.acp-hero:after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(90deg,var(--acp-in),var(--acp-out),transparent 92%) top/100% 2px no-repeat}
.acp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.acp-logo{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;color:#fff;flex:none;background:linear-gradient(135deg,var(--acp-in),var(--acp-out));box-shadow:0 4px 12px -4px color-mix(in srgb,var(--acp-in) 60%,transparent)}
.acp-h1{font-size:15px;font-weight:700;line-height:1.3}
.acp-hsub{font-size:11.5px;color:var(--acp-muted)}
.acp-sp{flex:1}
.acp-ctl{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:12px}
.acp-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--acp-sub);border:1px solid var(--acp-b1)}
.acp-seg button{font:inherit;font-size:12px;border:0;background:transparent;color:var(--acp-muted);padding:3px 11px;border-radius:7px;cursor:pointer}
.acp-seg button.on{background:var(--acp-card);color:var(--acp-fg);font-weight:600;box-shadow:0 1px 3px rgba(15,23,42,.14)}
.acp-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid var(--acp-b2);background:var(--acp-card);color:inherit;cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;gap:5px}
.acp-btn:hover{background:var(--acp-sub)}.acp-btn:disabled{opacity:.5;cursor:default}
.acp-btn.on{border-color:color-mix(in srgb,var(--acp-brand) 55%,transparent);color:var(--acp-brand);background:color-mix(in srgb,var(--acp-brand) 7%,var(--acp-card))}
.acp-cfg{position:relative}.acp-cfg svg{flex:none}
@property --acp-a{syntax:'<angle>';inherits:false;initial-value:0deg}
.acp-cfg-wrap{position:relative;display:inline-flex}
.acp-cfg.guide{overflow:hidden;color:#fff;font-weight:600;border:1.5px solid transparent;background:linear-gradient(135deg,var(--acp-brand),color-mix(in srgb,var(--acp-brand) 60%,#a855f7)) padding-box,conic-gradient(from var(--acp-a),#22d3ee,#a855f7,#f472b6,var(--acp-brand),#22d3ee) border-box;animation:acp-cfg-spin 3s linear infinite,acp-breathe 2.2s ease-in-out infinite}
.acp-cfg.guide:hover{filter:brightness(1.08)}
.acp-cfg.guide::before{content:"";position:absolute;top:0;bottom:0;left:-60%;width:40%;pointer-events:none;background:linear-gradient(100deg,transparent,rgba(255,255,255,.55),transparent);transform:skewX(-18deg);animation:acp-shine 3.2s ease-in-out infinite}
.acp-cfg.guide svg{animation:acp-wiggle 2.8s ease-in-out infinite;transform-origin:50% 50%}
.acp-cfg.guide .n{background:#fff;color:var(--acp-brand)}
@keyframes acp-cfg-spin{to{--acp-a:360deg}}
@keyframes acp-breathe{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--acp-brand) 45%,transparent),0 4px 12px -4px color-mix(in srgb,var(--acp-brand) 55%,transparent)}50%{box-shadow:0 0 0 7px color-mix(in srgb,var(--acp-brand) 0%,transparent),0 6px 18px -4px color-mix(in srgb,var(--acp-brand) 80%,transparent)}}
@keyframes acp-shine{0%{left:-60%}55%,100%{left:130%}}
.acp-coach{position:absolute;top:calc(100% + 11px);left:-6px;z-index:40;display:flex;align-items:stretch;gap:2px;width:max-content;max-width:min(300px,80vw);padding:3px;border-radius:12px;color:#fff;background:linear-gradient(135deg,var(--acp-brand),color-mix(in srgb,var(--acp-brand) 55%,#a855f7));box-shadow:0 14px 30px -12px color-mix(in srgb,var(--acp-brand) 75%,transparent),0 2px 6px rgba(0,0,0,.14);animation:acp-coach-in .5s cubic-bezier(.2,.9,.3,1.35) both,acp-bob 2.4s ease-in-out .5s infinite}
.acp-coach::before{content:"";position:absolute;top:-5px;left:24px;width:12px;height:12px;border-radius:2px;background:var(--acp-brand);transform:rotate(45deg);z-index:-1}
.acp-coach .body{display:flex;align-items:center;gap:9px;padding:6px 8px 6px 9px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:9px}
.acp-coach .body:hover{background:rgba(255,255,255,.14)}
.acp-coach .body b{display:block;font-size:12.5px;font-weight:700;white-space:nowrap}
.acp-coach .body small{display:block;font-size:11px;opacity:.88;white-space:nowrap;margin-top:1px}
.acp-coach .spark{font-size:16px;line-height:1;display:inline-block;animation:acp-twinkle 1.6s ease-in-out infinite}
.acp-coach .x{border:0;background:none;color:inherit;opacity:.75;font-size:17px;line-height:1;padding:0 8px;cursor:pointer;border-radius:8px}
.acp-coach .x:hover{opacity:1;background:rgba(255,255,255,.14)}
@keyframes acp-coach-in{from{opacity:0;transform:translateY(8px) scale(.94)}}
@keyframes acp-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes acp-twinkle{0%,100%{transform:scale(1) rotate(0);opacity:1}50%{transform:scale(1.3) rotate(25deg);opacity:.7}}
.acp-cfg .n{min-width:16px;height:16px;padding:0 5px;border-radius:8px;background:var(--acp-brand);color:#fff;font-size:10.5px;font-weight:700;line-height:16px;text-align:center;box-sizing:border-box}
.acp-guide{position:absolute;top:-4px;right:-4px;width:9px;height:9px;pointer-events:none}
.acp-guide::before,.acp-guide::after{content:"";position:absolute;inset:0;border-radius:50%;background:var(--acp-brand)}
.acp-guide::before{animation:acp-ping 1.6s cubic-bezier(0,0,.2,1) infinite}
.acp-guide::after{box-shadow:0 0 0 2px var(--acp-card)}
@keyframes acp-ping{75%,100%{transform:scale(2.8);opacity:0}}
@keyframes acp-wiggle{0%,80%,100%{transform:rotate(0)}85%{transform:rotate(-14deg)}90%{transform:rotate(12deg)}95%{transform:rotate(-6deg)}}
@media (prefers-reduced-motion:reduce){.acp-guide::before,.acp-cfg.guide,.acp-cfg.guide::before,.acp-cfg.guide svg,.acp-coach,.acp-coach .spark{animation:none}.acp-cfg.guide::before{display:none}}
.acp-live{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:2px 9px;border-radius:999px;color:var(--acp-warn);background:color-mix(in srgb,var(--acp-warn) 10%,var(--acp-card));border:1px solid color-mix(in srgb,var(--acp-warn) 30%,transparent)}
.acp-live i{width:7px;height:7px;border-radius:50%;background:currentColor;animation:acp-pulse 1.4s ease-in-out infinite}
.acp-alert{border:1px solid color-mix(in srgb,var(--acp-err) 45%,transparent);background:color-mix(in srgb,var(--acp-err) 6%,var(--acp-card));color:var(--acp-err);border-radius:10px;padding:8px 12px;margin-bottom:10px}
.acp-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:10px}
.acp-kpi{position:relative;display:flex;flex-direction:column;gap:1px;padding:10px 12px 8px 14px;border-radius:12px;border:1px solid var(--acp-b2);background:var(--acp-card);box-shadow:var(--acp-shadow);overflow:hidden;min-width:0}
.acp-kpi:before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--k,var(--acp-in))}
.acp-kpi .l{font-size:11px;color:var(--acp-muted);white-space:nowrap}
.acp-kpi .v{font-size:21px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.25;white-space:nowrap}
.acp-kpi .v small{font-size:12px;font-weight:600;color:var(--acp-muted);margin-left:2px}
.acp-kpi .s{font-size:10.5px;color:var(--acp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acp-kpi .viz{margin-top:6px;min-height:26px}
.acp-kpi .ring{position:absolute;right:10px;top:10px}
.acp-dots{display:flex;gap:8px;flex-wrap:wrap}.acp-dots span{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--acp-muted)}.acp-dots i{width:8px;height:8px;border-radius:50%}
.acp-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:10px;margin-bottom:10px}
.s3{grid-column:span 3}.s4{grid-column:span 4}.s5{grid-column:span 5}.s7{grid-column:span 7}.s8{grid-column:span 8}.s12{grid-column:span 12}
@container (max-width:900px){.s3,.s4,.s5,.s7,.s8{grid-column:span 12}.m6{grid-column:span 6}}
@container (max-width:560px){.m6{grid-column:span 12}}
.acp-card{background:var(--acp-card);border:1px solid var(--acp-b2);border-radius:12px;padding:12px 14px;box-shadow:var(--acp-shadow);min-width:0}
.acp-ct{display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--acp-b1);font-weight:650;min-width:0}
.acp-ct:before{content:"";width:3px;height:12px;border-radius:2px;background:var(--acp-in);flex:none}
.acp-ct .sub{font-weight:400;color:var(--acp-muted);font-size:11.5px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acp-legend{display:flex;gap:12px;font-size:11px;color:var(--acp-muted);margin-left:auto;font-weight:400}.acp-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}
.acp-tt{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 10px}
.acp-tt-l{font-size:11px;color:var(--acp-muted);white-space:nowrap}
.acp-legend.wrap{flex-wrap:wrap;gap:6px 12px;margin:10px 0 0;align-items:center}
.acp-tps svg{display:block;width:100%;height:auto;overflow:visible}
.acp-tps .ax{font-size:9.5px;fill:var(--acp-faint)}
.acp-tps .gl{stroke:var(--acp-b1);stroke-dasharray:3 3}
.acp-tps circle{cursor:default}
.acp-lg{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.acp-lg button{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--acp-b2);background:var(--acp-card);color:inherit;cursor:pointer;max-width:100%}
.acp-lg button i{width:8px;height:8px;border-radius:50%;flex:none}
.acp-lg button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acp-lg button b{font-variant-numeric:tabular-nums;font-weight:650}
.acp-lg button.off{opacity:.45}.acp-lg button.off span{text-decoration:line-through}
.acp-lg button:disabled{cursor:default;opacity:.4}
.acp-drow{display:grid;grid-template-columns:70px minmax(0,1fr) 62px;gap:8px;align-items:center;font-size:11.5px;margin:7px 0;color:var(--acp-muted)}
.acp-drow b{color:var(--acp-fg);text-align:right;font-variant-numeric:tabular-nums;font-weight:650}.acp-drow b small{color:var(--acp-faint);font-weight:400;margin-left:3px}
.acp-hbar{height:10px;border-radius:5px;background:var(--acp-sub);overflow:hidden}
.acp-hbar .fill{display:flex;height:100%;border-radius:5px;overflow:hidden;transform-origin:left;animation:acp-grow .5s ease-out}
.acp-hbar .fill i{display:block;height:100%;min-width:2px}
.acp-grow{display:flex;align-items:flex-end;gap:4px;height:60px;margin-top:6px}
.acp-grow .c{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:0}
.acp-grow .c i{display:block;border-radius:3px 3px 0 0;background:color-mix(in srgb,var(--acp-in) 70%,transparent);min-height:2px;transform-origin:bottom;animation:acp-bar .5s ease-out}
.acp-grow-ax{display:flex;gap:4px;font-size:9.5px;color:var(--acp-faint);margin-top:3px}.acp-grow-ax span{flex:1;text-align:center}
.acp-chips-row{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.acp-lg{display:inline-flex;align-items:center;font:inherit;font-size:11px;color:var(--acp-fg);background:transparent;border:0;cursor:pointer;padding:2px 4px;border-radius:6px;line-height:1.3}
.acp-lg:hover{background:var(--acp-sub)}
.acp-lg.off{opacity:.42;text-decoration:line-through}
.acp-plot{width:100%;overflow:hidden}
.acp-bars{position:relative;display:flex;align-items:flex-end;gap:3px;height:150px;padding-top:4px;border-bottom:1px solid var(--acp-b2)}
.acp-bars.sm{height:64px}
.acp-bars .col{position:relative;z-index:1;flex:1;min-width:2px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;border-radius:5px 5px 0 0}
.acp-bars .seg{display:block;width:72%;margin:0 auto;transform-origin:bottom;animation:acp-bar .55s cubic-bezier(.2,.8,.2,1) both}
.acp-bars .seg:first-of-type{border-radius:4px 4px 0 0}
.acp-bars .seg.h{background:linear-gradient(to top,color-mix(in srgb,var(--acp-in) 45%,#fff),color-mix(in srgb,var(--acp-in) 85%,#fff))}
.acp-bars .seg.pk{background:linear-gradient(to top,color-mix(in srgb,var(--acp-in) 70%,#fff),var(--acp-in))}
.acp-axis{display:flex;gap:3px;margin-top:4px;font-size:10px;color:var(--acp-faint)}.acp-axis span{flex:1;min-width:2px;text-align:center;white-space:nowrap}
.acp-readout{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:10px;padding:6px 10px;border-radius:8px;background:var(--acp-sub);font-size:11.5px;color:var(--acp-muted)}
.acp-readout b{color:var(--acp-fg);font-variant-numeric:tabular-nums;font-weight:650}
.acp-donut{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap}
.acp-arc{animation:acp-donut .9s ease both;transition:stroke-width .15s,opacity .15s}
.acp-leg{display:flex;flex-direction:column;gap:4px;flex:1 1 170px;min-width:150px}
.acp-leg .row{display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 6px;border-radius:7px}
.acp-leg .row.hot{background:var(--acp-sub)}.acp-leg .row i{width:9px;height:9px;border-radius:3px;flex:none}
.acp-leg .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acp-leg .n{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:650;white-space:nowrap}
.acp-leg .p{color:var(--acp-muted);width:38px;text-align:right;font-variant-numeric:tabular-nums}
.acp-rank{display:flex;flex-direction:column;gap:8px}
.acp-rank .r{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:3px 8px;align-items:center;font-size:12px}
.acp-rank .no{font-size:10.5px;font-weight:700;color:var(--acp-faint);text-align:center;line-height:17px}
.acp-rank .no.top{color:#fff;border-radius:5px;background:linear-gradient(135deg,var(--acp-in),var(--acp-out))}
.acp-rank .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.acp-rank .nm small{color:var(--acp-muted);margin-left:5px}
.acp-rank .val{font-variant-numeric:tabular-nums;color:var(--acp-muted);font-size:11.5px;white-space:nowrap}.acp-rank .val b{color:var(--acp-fg)}
.acp-rank .track{grid-column:2/-1;height:6px;border-radius:4px;background:var(--acp-sub);overflow:hidden}
.acp-rank .track i{display:block;height:100%;border-radius:4px;transform-origin:left;animation:acp-grow .7s cubic-bezier(.2,.8,.2,1) both}
/* error-class breakdown (insights) */
.acp-ecbar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--acp-sub);margin:4px 0 10px}
.acp-ecbar i{display:block;height:100%;min-width:2px;transition:width .5s;min-width:0}
.acp-ecrow{display:grid;grid-template-columns:9px minmax(0,1fr) auto auto;gap:3px 7px;align-items:center;padding:4px 0;border-bottom:1px solid var(--acp-b1)}
.acp-ecrow:last-child{border-bottom:none}
.acp-ecrow .dot{width:9px;height:9px;border-radius:3px;flex:none}
.acp-ecrow .nm{font-weight:600;font-size:12px}.acp-ecrow .nm small{color:var(--acp-muted);font-weight:400;margin-left:5px;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acp-ecrow .n{font-variant-numeric:tabular-nums;font-weight:650;white-space:nowrap}
.acp-ecrow .p{font-variant-numeric:tabular-nums;color:var(--acp-muted);width:38px;text-align:right;white-space:nowrap}
/* dynamic usage/account probe (insights quota card) */
.acp-quota-refresh{cursor:pointer;border:1px solid var(--acp-b2);background:var(--acp-sub);color:var(--acp-fg);border-radius:6px;padding:3px 9px;font-size:11px;font-weight:600}
.acp-quota-refresh:hover{border-color:var(--acp-brand);color:var(--acp-brand)}
.acp-quota-refresh[disabled]{opacity:.5;cursor:default}
.acp-quota-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:8px 0;border-bottom:1px solid var(--acp-b1)}
.acp-quota-row:last-child{border-bottom:none}
.acp-quota-row .nm{font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px;min-width:0}
.acp-quota-row .nm i.dot{width:8px;height:8px;border-radius:3px;flex:none}
.acp-quota-row .nm span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acp-quota-row .det{grid-column:1/-1;font-size:11.5px;color:var(--acp-muted);padding-left:14px;line-height:1.55}
.acp-quota-row .det b{color:var(--acp-fg);font-variant-numeric:tabular-nums}
.acp-quota-row .det .src{color:var(--acp-faint);font-size:10.5px}
.acp-quota-row .ago{font-size:10.5px;color:var(--acp-faint);white-space:nowrap;font-variant-numeric:tabular-nums}
.acp-heat-wrap{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px}
.acp-heat,.acp-heat-days{display:grid;grid-template-rows:repeat(7,12px);gap:3px}
.acp-heat{grid-auto-flow:column;grid-auto-columns:12px}
.acp-heat i{border-radius:3px;background:var(--acp-sub);transition:transform .1s}
.acp-heat i:hover{transform:scale(1.25);outline:1px solid var(--acp-b2)}.acp-heat i.pad{background:transparent;outline:0;transform:none}
.acp-heat-days{font-size:9.5px;color:var(--acp-faint);line-height:12px}
.acp-heat-leg{display:flex;align-items:center;gap:3px;font-size:10px;color:var(--acp-faint);margin-top:8px}.acp-heat-leg i{width:10px;height:10px;border-radius:3px}
.acp-section{display:flex;align-items:center;gap:8px;margin:18px 0 10px;font-size:13px;font-weight:700}.acp-section small{font-weight:400;color:var(--acp-muted);font-size:11.5px}
.acp-provs{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:10px;margin-bottom:10px}
.acp-disc-wrap{position:relative;border:1px solid var(--acp-b2);border-radius:14px;padding:12px 14px;margin:18px 0 4px;box-shadow:var(--acp-shadow);background:linear-gradient(118deg,color-mix(in srgb,var(--acp-brand) 8%,transparent),transparent 46%),var(--acp-card)}
.acp-disc-hd{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.acp-disc-hd .ic{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;color:#fff;flex:none;background:linear-gradient(135deg,var(--acp-brand),color-mix(in srgb,var(--acp-brand) 55%,#111));box-shadow:0 6px 14px -6px color-mix(in srgb,var(--acp-brand) 80%,transparent)}
.acp-disc-hd .t{font-size:13.5px;font-weight:700}.acp-disc-hd .s{font-size:11.5px;color:var(--acp-muted);margin-top:1px}
.acp-disc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:9px;margin-top:12px}
.acp-disc-empty{margin-top:12px;padding:16px;border:1px dashed var(--acp-b2);border-radius:12px;text-align:center;color:var(--acp-muted);font-size:12px}
.acp-tile{position:relative;display:flex;flex-direction:column;gap:7px;min-width:0;padding:11px 12px;border-radius:12px;border:1px solid var(--acp-b2);background:var(--acp-card);transition:border-color .15s,box-shadow .15s,transform .15s}
.acp-tile:hover{border-color:color-mix(in srgb,var(--pc) 50%,var(--acp-b2));box-shadow:0 6px 18px -10px color-mix(in srgb,var(--pc) 60%,transparent);transform:translateY(-1px)}
.acp-tile.on{background:linear-gradient(118deg,color-mix(in srgb,var(--acp-ok) 6%,transparent),transparent 60%),var(--acp-card)}
.acp-tile .nm{font-weight:700;font-size:13px;display:flex;align-items:baseline;gap:6px;min-width:0}.acp-tile .nm>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.acp-tile .nm>small{flex:none}.acp-tile .nm small{font-weight:500;color:var(--acp-muted);font-size:11px}
.acp-tile .path{font:10.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--acp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acp-tile .note{font-size:11px;color:var(--acp-muted);line-height:1.45}
.acp-tile .ft{display:flex;justify-content:flex-end;gap:6px;margin-top:auto;padding-top:2px}
.acp-tile.in{animation:acp-tile-in .34s cubic-bezier(.2,.75,.3,1) backwards}
@keyframes acp-tile-in{from{opacity:0;transform:translateY(8px) scale(.985)}}
.acp-skel-tile{pointer-events:none;min-height:118px}
.acp-skel-tile .acp-skel{animation-delay:var(--d,0ms)}
.acp-disc-hd .s .acp-spin{display:inline-block;width:11px;height:11px;border-width:1.5px;vertical-align:-1px;margin-right:6px}
.acp-spin.on-pri{border-color:color-mix(in srgb,#fff 40%,transparent);border-top-color:#fff}
@media (prefers-reduced-motion:reduce){.acp-tile.in{animation:none}.acp-skel-tile .acp-skel{animation:none}}
.acp-av.sm{width:30px;height:30px;font-size:13px;border-radius:9px}
.acp-btn.pri{background:var(--acp-brand);border-color:var(--acp-brand);color:#fff;font-weight:600}.acp-btn.pri:hover:not(:disabled){filter:brightness(1.07)}
.acp-btn.danger{color:var(--acp-err);border-color:color-mix(in srgb,var(--acp-err) 40%,var(--acp-b2))}
.acp-btn.ghost{border-style:dashed;color:var(--acp-muted);align-self:flex-start}
.acp-btn:disabled{opacity:.5;cursor:default}
.acp-modal-box.acp-ed{width:min(760px,100%);max-height:90vh;padding:0;overflow:hidden}
.acp-ed-hd{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--acp-b1);background:linear-gradient(118deg,color-mix(in srgb,var(--acp-brand) 7%,transparent),transparent 55%)}
.acp-ed-title{font-size:15px;font-weight:700}.acp-ed-sub{font-size:11.5px;color:var(--acp-muted);margin-top:2px}
.acp-x{width:28px;height:28px;border-radius:8px;border:0;background:transparent;color:var(--acp-muted);font-size:20px;line-height:1;cursor:pointer;flex:none}.acp-x:hover{background:var(--acp-sub);color:var(--acp-fg)}.acp-x.sm{width:26px;height:26px;font-size:16px}
.acp-ed-body{flex:1;min-height:0;overflow:auto;padding:14px 18px;display:flex;flex-direction:column;gap:12px}
.acp-ed-sec{border:1px solid var(--acp-b1);border-radius:12px;padding:12px 14px;background:color-mix(in srgb,var(--acp-sub) 45%,var(--acp-card));display:flex;flex-direction:column;gap:10px}
.acp-ed-sec>.t{display:flex;align-items:baseline;gap:8px;font-size:12.5px;font-weight:700;margin:0;padding:0;border:0;background:none;color:inherit;font-family:inherit;text-align:left}
.acp-ed-sec>.t small{font-weight:400;font-size:11px;color:var(--acp-muted)}
.acp-ed-sec.fold>.t{cursor:pointer}.acp-ed-sec.fold:not(.open){padding-top:10px;padding-bottom:10px}.acp-ed-sec .car{width:12px;color:var(--acp-muted)}
.acp-ed-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px}.acp-ed-grid.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
.acp-fld{display:flex;flex-direction:column;gap:5px;min-width:0}.acp-fld.full{grid-column:1/-1}
.acp-fld>label{font-size:11px;font-weight:600;color:var(--acp-muted)}
.acp-fld .hint{font-size:10.5px;color:var(--acp-faint);line-height:1.4}.acp-fld .errt{font-size:10.5px;color:var(--acp-err)}
.acp-ed input{font:inherit;font-size:12.5px;padding:7px 10px;border-radius:9px;border:1px solid var(--acp-b2);background:var(--acp-card);color:inherit;width:100%;min-width:0;box-sizing:border-box;outline:none;transition:border-color .15s,box-shadow .15s}
.acp-ed input.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.acp-ed input:focus{border-color:var(--acp-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--acp-brand) 16%,transparent)}
.acp-ed input:disabled{background:var(--acp-sub);color:var(--acp-muted)}
.acp-fld.err input,.acp-env.err input:first-child{border-color:var(--acp-err)}
.acp-sfx{position:relative}.acp-sfx input{padding-right:44px}.acp-sfx span{position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--acp-faint);pointer-events:none}
.acp-seg.full{display:flex;width:100%;box-sizing:border-box}.acp-seg.full button{flex:1}
.acp-perm{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.acp-perm button{display:flex;flex-direction:column;gap:3px;text-align:left;padding:9px 11px;border-radius:10px;border:1px solid var(--acp-b2);background:var(--acp-card);color:inherit;font:inherit;cursor:pointer;transition:border-color .15s,background .15s}
.acp-perm button b{font-size:12.5px}.acp-perm button small{font-size:10.5px;color:var(--acp-muted);line-height:1.4}
.acp-perm button.on{border-color:var(--acp-brand);background:color-mix(in srgb,var(--acp-brand) 8%,var(--acp-card));box-shadow:inset 0 0 0 1px var(--acp-brand)}.acp-perm button.on b{color:var(--acp-brand)}
.acp-env{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,5fr) auto;gap:8px;align-items:center}
.acp-tgs{display:flex;gap:18px;flex-wrap:wrap}
.acp-tg{display:flex;align-items:center;gap:9px}.acp-tg>div{display:flex;flex-direction:column;cursor:pointer;user-select:none}.acp-tg b{font-size:12px}.acp-tg small{font-size:10.5px;color:var(--acp-muted)}
.acp-probe{border:1px solid var(--acp-b2);border-radius:11px;padding:10px 12px;font-size:11.5px;display:flex;flex-direction:column;gap:7px;background:var(--acp-card)}
.acp-probe.ok{border-color:color-mix(in srgb,var(--acp-ok) 35%,transparent);background:color-mix(in srgb,var(--acp-ok) 6%,var(--acp-card))}.acp-probe.ok>.acp-row>b{color:var(--acp-ok)}
.acp-probe.fail{border-color:color-mix(in srgb,var(--acp-err) 35%,transparent);background:color-mix(in srgb,var(--acp-err) 5%,var(--acp-card))}.acp-probe.fail>b{color:var(--acp-err)}
.acp-probe .msg{color:var(--acp-muted);overflow-wrap:anywhere}
.acp-probe:not(.ok):not(.fail){flex-direction:row;align-items:center;gap:8px;color:var(--acp-muted)}
.acp-mchips{display:flex;flex-wrap:wrap;gap:4px}.acp-mchips span{font:10.5px/18px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 7px;border-radius:6px;background:var(--acp-card);border:1px solid var(--acp-b1)}.acp-mchips .more{color:var(--acp-muted)}
.acp-spin{width:13px;height:13px;border-radius:50%;border:2px solid var(--acp-b2);border-top-color:var(--acp-brand);animation:acp-rot .8s linear infinite;flex:none}
@keyframes acp-rot{to{transform:rotate(360deg)}}
.acp-yaml{margin:0;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--acp-card);border:1px solid var(--acp-b1);border-radius:9px;padding:10px 12px;white-space:pre;overflow:auto;max-height:240px}
.acp-ed-ft{display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--acp-b1);background:var(--acp-card)}.acp-ed-ft .hint{font-size:11px;color:var(--acp-muted)}
.acp-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100;padding:8px 14px;border-radius:999px;font-size:12px;color:#fff;background:color-mix(in srgb,var(--acp-ok) 85%,#000);box-shadow:var(--acp-shadow)}
@media (max-width:640px){.acp-ed-grid,.acp-ed-grid.g4{grid-template-columns:repeat(2,minmax(0,1fr))}.acp-perm{grid-template-columns:1fr}}
.acp-prov{position:relative;min-width:0;border:1px solid var(--acp-b2);border-top:3px solid var(--pc);border-radius:12px;padding:12px 14px;box-shadow:var(--acp-shadow);background:linear-gradient(118deg,color-mix(in srgb,var(--pc) 9%,transparent),transparent 52%),var(--acp-card)}
.acp-prov.open{grid-column:1/-1}.acp-prov.off{opacity:.62;filter:grayscale(.55)}
.acp-av{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;font-weight:700;color:#fff;font-size:14px;flex:none;background:linear-gradient(135deg,var(--pc),color-mix(in srgb,var(--pc) 60%,#111));box-shadow:0 4px 10px -4px color-mix(in srgb,var(--pc) 70%,transparent)}
.acp-pname{font-weight:700;font-size:13.5px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acp-chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:3px}
.acp-chip{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;line-height:16px;padding:0 7px;border-radius:999px;border:1px solid var(--acp-b2);color:var(--acp-muted);white-space:nowrap;background:var(--acp-card)}
.acp-chip.mono,.acp-mono{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace)}.acp-mono{font-size:11px}
.acp-chip.ok{color:var(--acp-ok);border-color:color-mix(in srgb,var(--acp-ok) 35%,transparent);background:color-mix(in srgb,var(--acp-ok) 9%,var(--acp-card))}
.acp-chip.warn{color:var(--acp-warn);border-color:color-mix(in srgb,var(--acp-warn) 35%,transparent);background:color-mix(in srgb,var(--acp-warn) 9%,var(--acp-card))}
.acp-chip.fail{color:var(--acp-err);border-color:color-mix(in srgb,var(--acp-err) 35%,transparent);background:color-mix(in srgb,var(--acp-err) 8%,var(--acp-card))}
.acp-chip.brand{color:var(--acp-brand);border-color:color-mix(in srgb,var(--acp-brand) 35%,transparent);background:color-mix(in srgb,var(--acp-brand) 8%,var(--acp-card))}
.acp-chip.ok:before,.acp-chip.warn:before,.acp-chip.fail:before,.acp-chip.brand:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.acp-switch{position:relative;width:32px;height:18px;border-radius:9px;border:0;background:var(--acp-b2);cursor:pointer;flex:none;padding:0;transition:background .15s}
.acp-switch[aria-checked="true"]{background:var(--pc,var(--acp-brand))}
.acp-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}
.acp-switch[aria-checked="true"]::after{left:16px}.acp-switch:disabled{opacity:.5;cursor:default}
.acp-mini{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:12px 0 8px}
.acp-mini>div{background:color-mix(in srgb,var(--acp-sub) 85%,transparent);border-radius:9px;padding:6px 9px;min-width:0}
.acp-mini .l{font-size:10.5px;color:var(--acp-muted)}.acp-mini .v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@container (max-width:520px){.acp-mini{grid-template-columns:repeat(2,minmax(0,1fr))}}
.acp-meterline{display:flex;justify-content:space-between;font-size:11px;color:var(--acp-muted);margin:8px 0 3px}
.acp-meter{height:6px;border-radius:4px;background:var(--acp-sub);overflow:hidden}
.acp-meter i{display:block;height:100%;border-radius:4px;background:var(--pc);transform-origin:left;animation:acp-grow .7s ease both}
.acp-info{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;color:var(--acp-muted);margin-top:10px}.acp-info b{color:var(--acp-fg);font-weight:600}
.acp-det{margin-top:8px;font-size:11.5px}.acp-det summary{cursor:pointer;color:var(--acp-muted);user-select:none}
.acp-dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;margin:6px 0 0;padding:8px 10px;border-radius:9px;background:var(--acp-sub)}
.acp-dl dt{color:var(--acp-muted);white-space:nowrap}.acp-dl dd{margin:0;overflow-wrap:anywhere}
.acp-tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px}
.acp-input{font:inherit;font-size:12px;padding:4px 9px;border-radius:8px;border:1px solid var(--acp-b2);background:var(--acp-card);color:inherit;min-width:160px}
.acp-scroll{overflow-x:auto;max-width:100%}
.acp-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;font-variant-numeric:tabular-nums}
.acp-table th{text-align:left;font-weight:600;font-size:11px;color:var(--acp-muted);padding:6px 8px;border-bottom:1px solid var(--acp-b2);white-space:nowrap}
.acp-table td{padding:6px 8px;border-bottom:1px solid var(--acp-b1);white-space:nowrap}
.acp-table tbody tr:last-child td{border-bottom:0}.acp-table tbody tr:hover td{background:var(--acp-sub)}
.acp-table .num{text-align:right}.acp-table tr.dis td{color:var(--acp-faint)}.acp-table tr.dis td.name{text-decoration:line-through}
.acp-pv{display:inline-flex;align-items:center;gap:6px}.acp-pv i{width:8px;height:8px;border-radius:3px;flex:none}.acp-pv small{color:var(--acp-muted);font-size:11px}
.acp-cb{display:inline-flex;align-items:center;gap:6px;justify-content:flex-end;min-width:90px}
.acp-cb span{display:inline-block;height:5px;border-radius:3px;background:linear-gradient(90deg,var(--acp-in),var(--acp-out));min-width:2px}
.acp-rate{display:inline-block;font-size:10.5px;padding:0 6px;border-radius:5px;font-variant-numeric:tabular-nums;font-weight:650;line-height:17px}
.acp-rate.t0{color:#059669;background:color-mix(in srgb,#10b981 15%,transparent)}.acp-rate.t1{color:#0e7490;background:color-mix(in srgb,#06b6d4 15%,transparent)}
.acp-rate.t2{color:#b45309;background:color-mix(in srgb,#f59e0b 17%,transparent)}.acp-rate.t3{color:#be123c;background:color-mix(in srgb,#f43f5e 15%,transparent)}
.acp-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 0;color:var(--acp-muted);font-size:12px}.acp-empty svg{opacity:.45}
.acp-note{font-size:11px;color:var(--acp-muted);margin-top:8px}
.acp-foot{font-size:11px;color:var(--acp-faint);margin-top:14px;text-align:center;overflow-wrap:anywhere}
.acp-skel{border-radius:12px;background:linear-gradient(90deg,var(--acp-sub),color-mix(in srgb,var(--acp-sub) 40%,var(--acp-card)),var(--acp-sub));background-size:200% 100%;animation:acp-shimmer 1.3s linear infinite}
/* in-progress row → expandable per-session statistics */
.acp-table tbody tr.click{cursor:pointer}
.acp-table tbody tr.click:hover td{background:var(--acp-sub)}
.acp-table tbody tr.sel td{background:color-mix(in srgb,var(--acp-in) 8%,var(--acp-card))}
.acp-table tbody tr.sel td:first-child{box-shadow:inset 3px 0 var(--acp-in)}
.acp-go{text-align:right;white-space:nowrap}
.acp-go button{font:inherit;font-size:11px;color:var(--acp-faint);background:transparent;border:0;cursor:pointer;padding:2px 4px;border-radius:6px;white-space:nowrap}
.acp-go button:hover,.acp-table tbody tr.sel .acp-go button{color:var(--acp-brand)}
.acp-sd{border-top:1px dashed var(--acp-b2);margin-top:12px;padding-top:12px}
.acp-sd-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px}
.acp-sd-tag{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;color:var(--acp-warn);background:color-mix(in srgb,var(--acp-warn) 10%,var(--acp-card));border:1px solid color-mix(in srgb,var(--acp-warn) 28%,transparent)}
.acp-sd-tag i{width:7px;height:7px;border-radius:50%;background:currentColor;animation:acp-pulse 1.4s ease-in-out infinite}
.acp-sd-hd .sp{flex:1}
.acp-sd-info{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;color:var(--acp-muted);margin:6px 0 10px}
.acp-sd-info b{color:var(--acp-fg);font-weight:600}
.acp-sd-k{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:6px;margin-bottom:10px}
.acp-sd-k>div{background:color-mix(in srgb,var(--acp-sub) 85%,transparent);border-radius:9px;padding:6px 9px;min-width:0}
.acp-sd-k .l{font-size:10.5px;color:var(--acp-muted)}
.acp-sd-k .v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acp-sd-sub{font-size:11px;font-weight:650;color:var(--acp-muted);margin:12px 0 6px}
.acp-sd-mm{display:flex;flex-wrap:wrap;gap:6px}
.acp-sd-mm>span{font-size:11px;color:var(--acp-muted);background:var(--acp-sub);border-radius:7px;padding:2px 8px}
.acp-sd-mm b{color:var(--acp-fg);font-variant-numeric:tabular-nums}
.acp-sd-note{font-size:10.5px;color:var(--acp-faint);margin-top:10px;line-height:1.5}
.acp-seg.mini{padding:1px;gap:1px}
.acp-seg.mini button{padding:1px 8px;font-size:10.5px;border-radius:6px}
/* latency distribution */
.acp-lat-k{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-bottom:10px}
.acp-lat-k>div{background:var(--acp-sub);border-radius:8px;padding:6px 8px;min-width:0}
.acp-lat-k .l{font-size:10.5px;color:var(--acp-muted)}
.acp-lat-k .v{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acp-lat-track{position:relative;height:10px;border-radius:5px;background:var(--acp-sub);margin:2px 0 6px}
.acp-lat-track i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,color-mix(in srgb,var(--acp-time) 45%,#fff),var(--acp-time))}
.acp-lat-track u{position:absolute;top:-3px;width:2px;height:16px;border-radius:2px;background:var(--acp-fg);opacity:.55}
.acp-lat-track u.p90{background:var(--acp-err);opacity:.9}
.acp-ll{font-size:10.5px;color:var(--acp-faint);display:flex;justify-content:space-between;margin-bottom:8px}
.acp-mini-list{display:flex;flex-direction:column;gap:6px}
.acp-mini-list .r{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--acp-muted);min-width:0}
.acp-mini-list .r .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acp-mini-list .r b{color:var(--acp-fg);font-weight:650;margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}
.acp-mini-list .r .bar{width:44px;height:5px;border-radius:3px;background:var(--acp-sub);overflow:hidden;flex:none}
.acp-mini-list .r .bar i{display:block;height:100%;border-radius:3px;background:var(--acp-time)}
.acp-sub-h{font-size:10.5px;font-weight:650;color:var(--acp-muted);margin:10px 0 5px}
/* cache */
.acp-big{display:flex;align-items:baseline;gap:6px;margin:2px 0}
.acp-big .v{font-size:26px;font-weight:750;font-variant-numeric:tabular-nums;line-height:1.2}
.acp-big .u{font-size:12px;color:var(--acp-muted)}
.acp-kv2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:10px 0 2px}
.acp-kv2>div{background:var(--acp-sub);border-radius:8px;padding:6px 9px;min-width:0}
.acp-kv2 .l{font-size:10.5px;color:var(--acp-muted)}
.acp-kv2 .v{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* credit */
.acp-cr{display:flex;flex-direction:column;gap:7px}
.acp-cr .row{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:2px 7px;align-items:center;font-size:11.5px}
.acp-cr .no{font-size:10px;color:var(--acp-faint);text-align:center}
.acp-cr .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acp-cr .nm small{color:var(--acp-muted);margin-left:4px}
.acp-cr .val{font-variant-numeric:tabular-nums;font-weight:650;white-space:nowrap}
.acp-cr .track{grid-column:2/-1;height:5px;border-radius:3px;background:var(--acp-sub);overflow:hidden}
.acp-cr .track i{display:block;height:100%;border-radius:3px}
/* data quality */
.acp-quality{display:flex;align-items:center;gap:9px;flex-wrap:wrap;border:1px solid var(--acp-b2);border-radius:10px;padding:7px 11px;margin:-2px 0 8px;background:var(--acp-card);font-size:11px;color:var(--acp-muted)}
.acp-quality b{color:var(--acp-fg)}
.acp-quality .bar{flex:1 1 120px;min-width:70px;height:6px;border-radius:4px;background:var(--acp-sub);overflow:hidden}
.acp-quality .bar i{display:block;height:100%;background:linear-gradient(90deg,color-mix(in srgb,var(--acp-warn) 50%,#fff),var(--acp-warn))}
.acp-quality .chip{font-size:10.5px;background:var(--acp-sub);border-radius:6px;padding:1px 7px}
/* errors drill-down */
.acp-rank .r.click{cursor:pointer;border-radius:7px;padding:2px 4px;margin:-2px -4px}
.acp-rank .r.click:hover{background:var(--acp-sub)}
.acp-rank .r.sel{background:color-mix(in srgb,var(--acp-err) 7%,var(--acp-card))}
.acp-errd{margin:2px 0 6px;padding:7px 9px;border-radius:8px;background:var(--acp-sub);font-size:11px;color:var(--acp-muted);display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px}
.acp-errd dt{color:var(--acp-muted);white-space:nowrap}
.acp-errd dd{margin:0;overflow-wrap:anywhere;color:var(--acp-fg)}
/* session pool */
.acp-pool{margin:8px 0 2px}
.acp-pool-hd{display:flex;justify-content:space-between;font-size:10.5px;color:var(--acp-muted);margin-bottom:4px}
.acp-pool-segs{display:flex;gap:3px}
.acp-pool-segs i{flex:1;height:7px;border-radius:3px;background:var(--acp-sub)}
.acp-pool-segs i.warm{background:color-mix(in srgb,var(--acp-ok) 65%,#fff)}
.acp-pool-segs i.live{background:var(--acp-warn)}
/* in-flight timeout meter */
.acp-tm{display:flex;align-items:center;gap:6px;min-width:78px}
.acp-tm .bar{flex:1;height:5px;border-radius:3px;background:var(--acp-sub);overflow:hidden;min-width:34px}
.acp-tm .bar i{display:block;height:100%;border-radius:3px;background:var(--acp-in)}
.acp-tm.near .bar i{background:var(--acp-warn)}
.acp-tm.over .bar i{background:var(--acp-err)}
.acp-tm span{font-size:10.5px;color:var(--acp-muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.acp-tm.near span,.acp-tm.over span{color:var(--acp-warn)}
@keyframes acp-bar{from{transform:scaleY(0)}}@keyframes acp-grow{from{transform:scaleX(0)}}@keyframes acp-donut{from{stroke-dasharray:0 100}}
@keyframes acp-pulse{0%,100%{opacity:1}50%{opacity:.3}}@keyframes acp-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.acp *{animation:none!important;transition:none!important}}
/* interactions: filter bar, compare strip, drill-down, table toolbar, report modal, fold, compact */
.acp-fold{font:inherit;border:0;background:transparent;color:var(--acp-faint);cursor:pointer;padding:0 2px;font-size:11px;line-height:1;flex:none}
.acp-fold:hover{color:var(--acp-fg)}
.acp-filterbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;border:1px solid color-mix(in srgb,var(--acp-brand) 35%,transparent);background:color-mix(in srgb,var(--acp-brand) 6%,var(--acp-card));border-radius:10px;padding:6px 10px;margin-bottom:10px;font-size:11.5px}
.acp-filterbar .chip{display:inline-flex;align-items:center;gap:4px;background:var(--acp-card);border:1px solid var(--acp-b2);border-radius:999px;padding:1px 8px;font-weight:600}
.acp-filterbar.warn{border-color:color-mix(in srgb,var(--acp-warn) 45%,transparent);background:color-mix(in srgb,var(--acp-warn) 7%,var(--acp-card))}
.acp-cmp{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border:1px solid var(--acp-b1);background:var(--acp-sub);border-radius:10px;padding:6px 10px;margin-bottom:10px;font-size:11.5px;color:var(--acp-muted)}
.acp-cmp b{font-variant-numeric:tabular-nums;color:var(--acp-fg)}
.acp-cmp b.up{color:var(--acp-ok)}.acp-cmp b.dn{color:var(--acp-err)}
.acp-date{font:inherit;font-size:11.5px;padding:3px 6px;border-radius:7px;border:1px solid var(--acp-b2);background:var(--acp-card);color:inherit}
.acp-link{font:inherit;border:0;background:transparent;color:var(--acp-brand);cursor:pointer;padding:0;text-decoration:underline dotted;text-align:left}
.acp-tbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.acp-tbar select,.acp-tbar input{font:inherit;font-size:11.5px;padding:3px 8px;border-radius:7px;border:1px solid var(--acp-b2);background:var(--acp-card);color:inherit}
.acp-table th.sort{cursor:pointer;user-select:none}
.acp-table th.sort:hover{color:var(--acp-brand)}
.acp-rank.pick .r.sel{outline:1px solid color-mix(in srgb,var(--acp-brand) 55%,transparent);background:color-mix(in srgb,var(--acp-brand) 6%,transparent)}
.acp-donut .click{cursor:pointer}
.acp-drill{border-top:1px dashed var(--acp-b2);margin-top:10px;padding-top:2px}
/* session × model distribution */
.acp-smx .lbl{fill:var(--acp-fg);cursor:pointer}
.acp-smx .lbl:hover{fill:var(--acp-brand)}
.acp-smx .lbl.on{fill:var(--acp-brand);font-weight:700}
.acp-smx .val{fill:var(--acp-muted)}
.acp-smx .ax{fill:var(--acp-faint)}
.acp-matrix th.m{text-align:right;cursor:pointer;user-select:none}
.acp-matrix th.m:hover{color:var(--acp-brand)}
.acp-matrix td.heat{text-align:right}
.acp-matrix td.none{text-align:right;color:var(--acp-faint)}
.acp-matrix td.sum{text-align:right;font-weight:650}
.acp-matrix tr.sel td:first-child{box-shadow:inset 3px 0 var(--acp-brand)}
.acp-modal{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:99;padding:20px}
.acp-modal-box{background:var(--acp-card);border-radius:14px;border:1px solid var(--acp-b2);box-shadow:var(--acp-shadow);width:min(680px,100%);max-height:86vh;display:flex;flex-direction:column;padding:14px 16px}
.acp-modal-box textarea{flex:1;min-height:300px;font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--acp-b2);border-radius:8px;padding:10px;background:var(--acp-sub);color:inherit;resize:vertical}
.acp-sdseg{cursor:pointer;transition:opacity .15s}
.acp-sdseg:hover{opacity:.82}
.acp-sdlab{cursor:pointer}
.acp-sdlab:hover{fill:var(--acp-in)}
.acp-mx td.cell{cursor:pointer;border-radius:4px}
.acp-mx td.cell:hover{outline:1px solid var(--acp-b2)}
.acp-mx td.cell.sel{outline:1.5px solid var(--acp-in)}
.acp-mx th .dot{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:4px;vertical-align:middle}
.acp-mx td{white-space:nowrap}
.acp-page{padding:18px 22px 48px}
.acp-pagehead{display:flex;flex-direction:column;gap:2px;margin:0 0 14px}
.acp-pagehead h1{font-size:18px;font-weight:750;margin:0;line-height:1.3}
.acp-pagehead .sub{font-size:12px;color:var(--acp-muted)}
.acp-entries{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 0 10px;font-size:11.5px;color:var(--acp-muted)}
.acp-entries label{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none}
.acp-entries input{accent-color:var(--acp-brand);margin:0}
.acp-modal-box.acp-sessionbox{width:min(1040px,100%);max-height:90vh;height:90vh}
.acp-sessionbox .acp{height:auto;flex:1;min-height:0;overflow:auto;padding:10px 12px 24px}
.acp.compact{padding:8px 10px 30px;font-size:12px}
.acp.compact .acp-card{padding:8px 10px;border-radius:9px}
.acp.compact .acp-kpi{padding:7px 9px 6px 11px}
.acp.compact .acp-kpi .v{font-size:17px}
.acp.compact .acp-grid,.acp.compact .acp-kpis{gap:6px;margin-bottom:6px}
.acp.compact .acp-hero{padding:10px 12px 8px;margin-bottom:8px}
.acp.compact .acp-big .v{font-size:20px}
`

    // ── formatting ──
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const n0 = (v) => num(v).toLocaleString('zh-CN')
    const compact = (v) => { v = num(v); if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`; if (v >= 1e4) return `${(v / 1e4).toFixed(v >= 1e6 ? 0 : 1)}万`; return String(Math.round(v)) }
    const dur = (ms) => { ms = num(ms); if (ms <= 0) return '-'; if (ms < 1000) return `${Math.round(ms)}ms`; if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`; if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}分${Math.round(ms / 1000) % 60}秒`; return `${(ms / 3_600_000).toFixed(1)}小时` }
    const pad = (x) => String(x).padStart(2, '0')
    const fmtTime = (t) => { if (!t) return '-'; const d = new Date(t); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
    const ago = (t) => { if (!t) return '从未'; const s = Math.max(0, (Date.now() - t) / 1000); if (s < 60) return `${Math.round(s)} 秒前`; if (s < 3600) return `${Math.round(s / 60)} 分钟前`; if (s < 86400) return `${Math.round(s / 3600)} 小时前`; return `${Math.round(s / 86400)} 天前` }
    const pctN = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0)
    const pct = (a, b) => (b > 0 ? `${pctN(a, b)}%` : '-')
    const rateNum = (r) => (typeof r === 'string' ? Number.parseFloat(r) : Number.NaN)
    const rateMul = (r) => { const n = rateNum(r); return Number.isFinite(n) && n >= 0 ? n : 1 }
    const rateTier = (r) => { const n = rateNum(r); if (!Number.isFinite(n)) return ''; return n === 0 ? 't0' : n < 0.3 ? 't1' : n < 1 ? 't2' : 't3' }
    const tokOf = (x) => num(x?.inputTokens) + num(x?.outputTokens)
    const short = (name) => String(name ?? '').replace(/\s*[（(]外部 CLI · external CLI[)）]\s*$/, '')
    const sess = (s) => (s ? String(s).replace(/^session-/, '').slice(0, 8) : '-')
    /** Project folder name of a working directory — the recognizable part of a session. */
    const projectOf = (cwd) => { const c = String(cwd ?? '').replace(/\/+$/, ''); return c ? (c.slice(c.lastIndexOf('/') + 1) || c) : '' }
    /** Display-name fallback when no catalog lookup is wired (standalone renders). */
    const rawModelOf = (pid, id) => id ?? 'default'
    const PERM = { allow: '全部放行', read: '只读放行', reject: '拒绝授权' }
    const STATUS = { ok: ['ok', '正常'], warn: ['warn', '有失败'], fail: ['fail', '异常'], loading: ['brand', '读取中'], off: ['', '已停用'] }

    // ── console preferences (localStorage, survive refresh) ──
    const LS_KEY = 'dsh-llm-acp.console.v1'
    const loadPrefs = () => { try { return (typeof localStorage !== 'undefined' && JSON.parse(localStorage.getItem(LS_KEY))) || {} } catch { return {} } }
    function createStore(initial) {
      let value = initial
      const subs = new Set()
      return {
        get: () => value,
        set: (next) => { value = next; for (const f of [...subs]) { try { f() } catch {} } },
        subscribe: (f) => { subs.add(f); return () => { subs.delete(f) } },
      }
    }
    /** Re-render on store changes using only useState/useEffect. */
    function useStore(store) {
      const [, force] = useState(0)
      useEffect(() => store.subscribe(() => force((x) => x + 1)), [store])
      return store.get()
    }
    // Entry switches (insights page / slash command) live in the same localStorage prefs; the
    // store lets apply()'s gates follow toggles without a reload.
    const DEFAULT_ENTRIES = { page: true, slash: true, pickerColor: true }
    const mergeEntries = (e) => ({ ...DEFAULT_ENTRIES, ...(e || {}) })
    const entryStore = createStore(mergeEntries(loadPrefs().entries))
    const savePrefs = (p) => {
      try {
        if (typeof localStorage === 'undefined') return
        const next = { ...loadPrefs(), ...p }
        localStorage.setItem(LS_KEY, JSON.stringify(next))
        entryStore.set(mergeEntries(next.entries))
      } catch { /* storage unavailable */ }
    }
    const dateStr = (t) => { const d = new Date(num(t)); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

    async function getJson(path) {
      const r = await fetch(path, { credentials: 'same-origin' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`)
      return j
    }
    async function post(path, body) {
      const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`)
      return j
    }

    // ── visual primitives ──
    function Spark({ values, color }) {
      const v = values.length ? values : [0]
      const max = Math.max(1, ...v.map(num))
      const n = v.length
      const pts = v.map((y, i) => [n === 1 ? 50 : (i / (n - 1)) * 100, 25 - (num(y) / max) * 22])
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ')
      const area = `${line} L${pts[n - 1][0].toFixed(2)},27 L${pts[0][0].toFixed(2)},27 Z`
      return h('svg', { viewBox: '0 0 100 27', preserveAspectRatio: 'none', width: '100%', height: 26, style: { display: 'block', overflow: 'visible' }, 'aria-hidden': true },
        h('path', { d: area, fill: color, fillOpacity: 0.13 }),
        h('path', { d: line, fill: 'none', stroke: color, strokeWidth: 1.7, vectorEffect: 'non-scaling-stroke', strokeLinejoin: 'round', strokeLinecap: 'round' }))
    }
    function Ring({ value, color, label, size = 46 }) {
      const p = Math.max(0, Math.min(100, num(value)))
      return h('svg', { viewBox: '0 0 42 42', width: size, height: size, className: 'ring', 'aria-hidden': true },
        h('circle', { cx: 21, cy: 21, r: 15.915, fill: 'none', strokeWidth: 5, style: { stroke: 'var(--acp-sub)' } }),
        p > 0 ? h('circle', { cx: 21, cy: 21, r: 15.915, fill: 'none', stroke: color, strokeWidth: 5, pathLength: 100, strokeDasharray: `${p} ${100 - p}`, strokeDashoffset: 25, strokeLinecap: 'round', className: 'acp-arc' }) : null,
        h('text', { x: 21, y: 24, textAnchor: 'middle', fontSize: 9, fontWeight: 700, style: { fill: 'var(--acp-fg)' } }, label))
    }
    function Kpi({ label, value, unit, sub, color, children, ring }) {
      return h('div', { className: 'acp-kpi', style: { '--k': color } },
        h('div', { className: 'l' }, label),
        h('div', { className: 'v' }, value, unit ? h('small', null, unit) : null),
        sub ? h('div', { className: 's', title: typeof sub === 'string' ? sub : undefined }, sub) : null,
        ring ?? null,
        children ? h('div', { className: 'viz' }, children) : null)
    }
    function Card({ title, sub, right, className, children, collapsed, onToggle }) {
      return h('div', { className: `acp-card${className ? ` ${className}` : ''}` },
        h('div', { className: 'acp-ct' },
          onToggle ? h('button', { type: 'button', className: 'acp-fold', 'aria-expanded': String(!collapsed), title: collapsed ? '展开卡片' : '折叠卡片', onClick: onToggle }, collapsed ? '▸' : '▾') : null,
          h('span', null, title), right ?? (sub ? h('span', { className: 'sub' }, sub) : null)),
        collapsed ? null : children)
    }
    function Empty({ text }) {
      return h('div', { className: 'acp-empty' },
        h('svg', { viewBox: '0 0 24 24', width: 28, height: 28, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' },
          h('path', { d: 'M3 20h18' }), h('path', { d: 'M6 16v-4' }), h('path', { d: 'M11 16V8' }), h('path', { d: 'M16 16v-6' })),
        text)
    }
    function Switch({ checked, disabled, label, onChange }) {
      return h('button', { type: 'button', role: 'switch', className: 'acp-switch', 'aria-checked': String(checked), 'aria-label': label, title: label, disabled, onClick: () => onChange(!checked) })
    }
    const Chip = ({ kind = '', mono, title, children }) => h('span', { className: `acp-chip${kind ? ` ${kind}` : ''}${mono ? ' mono' : ''}`, title }, children)
    const Rate = ({ rate }) => (rate ? h('span', { className: `acp-rate ${rateTier(rate)}` }, rate) : h('span', { style: { color: 'var(--acp-faint)' } }, '-'))
    const ResultChip = ({ r }) => (r.ok ? h(Chip, { kind: 'ok' }, '成功') : r.aborted || r.code === 'DISPOSED' ? h(Chip, { title: r.message }, '中断') : h(Chip, { kind: 'fail', title: r.message }, r.code ?? '失败'))
    const Prov = ({ color, name, model, title }) => h('span', { className: 'acp-pv', title }, h('i', { style: { background: color } }), model ? h('span', { className: 'acp-mono' }, model) : null, h(model ? 'small' : 'span', null, name))

    // ── charts ──
    // Daily Token trend: 3 chart types × 3 split dimensions, with a toggleable legend.
    const TYPES = [['stacked', '堆积柱状', '堆积柱状图'], ['grouped', '柱状', '分组柱状图'], ['line', '折线', '折线图']]
    const DIMS = [['io', '输入/输出', '按输入 / 输出 Token 拆分'], ['model', '模型', '按模型拆分，区分每个模型的贡献'], ['provider', '提供方', '按 ACP CLI 提供方拆分']]
    const C_OTHER = '#94a3b8'

    /** Fallback per-day model slices from the per-turn log, for a host not yet restarted to the
     *  version that ships byDay[].models. Capped by that log's `recent` window (last 100 turns). */
    function recentModelDays(days, recent) {
      const byDate = {}
      const dayKey = (t) => { const d = new Date(num(t)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
      for (const r of recent ?? []) {
        const date = dayKey(r.at)
        const k = `${r.provider}/${r.model ?? 'default'}`
        const m = byDate[date] ?? (byDate[date] = {})
        const e = m[k] ?? (m[k] = { inputTokens: 0, outputTokens: 0, turns: 0 })
        e.inputTokens += num(r.inputTokens)
        e.outputTokens += num(r.outputTokens)
        e.turns++
      }
      return days.map((d) => byDate[d.date] ?? {})
    }

    /** Per-day estimated-token totals from the per-turn log — fallback for hosts that don't
     *  ship byDay[].estimatedTokens yet. Separate from recentModelDays' slice shape. */
    function recentEstimatedDays(days, recent) {
      const byDate = {}
      const dayKey = (t) => { const d = new Date(num(t)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
      for (const r of recent ?? []) {
        if (!r.estimated) continue
        const k = dayKey(r.at)
        byDate[k] = (byDate[k] ?? 0) + num(r.inputTokens) + num(r.outputTokens)
      }
      return days.map((d) => byDate[d.date] ?? 0)
    }

    /** Series (one { key, label, full, color, values[] aligned to days }) for a split dimension.
     *  `modelDays` overrides byDay[].models when given (pre-restart fallback).
     *  `modelOf(provider, id)` maps model ids to catalog display names when given. */
    function seriesFor(days, dim, colorOf, nameOf, modelDays, modelOf) {
      const sum = (a) => a.reduce((s, v) => s + num(v), 0)
      if (dim === 'io') return [
        { key: 'in', label: '输入', full: '输入 Token', color: C_IN, values: days.map((d) => num(d.inputTokens)) },
        { key: 'out', label: '输出', full: '输出 Token', color: C_OUT, values: days.map((d) => num(d.outputTokens)) },
      ]
      if (dim === 'provider') {
        const keys = new Set()
        for (const d of days) for (const k of Object.keys(d.providers ?? {})) keys.add(k)
        return [...keys].map((pid) => {
          const values = days.map((d) => num(d.providers?.[pid]))
          return { key: pid, label: nameOf(pid), full: pid, color: colorOf(pid), values, total: sum(values) }
        }).filter((s) => s.total > 0).sort((a, b) => b.total - a.total)
      }
      // model: union across days, ranked by total tokens; keep the top 6 + one "其他" bucket.
      const modelsOf = (d, i) => (modelDays ? modelDays[i] : d.models) ?? {}
      const totals = {}
      days.forEach((d, i) => {
        const m = modelsOf(d, i)
        for (const k of Object.keys(m)) {
          const e = m[k] ?? {}
          totals[k] = (totals[k] ?? 0) + num(e.inputTokens) + num(e.outputTokens)
        }
      })
      const keys = Object.keys(totals).filter((k) => totals[k] > 0).sort((a, b) => totals[b] - totals[a])
      const top = keys.slice(0, 6)
      const rest = keys.slice(6)
      const valOf = (d, i, k) => { const e = modelsOf(d, i)[k]; return e ? num(e.inputTokens) + num(e.outputTokens) : 0 }
      const mk = (k, label, color) => ({ key: k, label, full: k, color, values: days.map((d, i) => valOf(d, i, k)) })
      const labelOf = (k) => { const mid = k.slice(k.indexOf('/') + 1) || k; return modelOf ? modelOf(k.slice(0, k.indexOf('/')), mid) : mid }
      const out = top.map((k, i) => mk(k, labelOf(k), PALETTE[i % PALETTE.length]))
      // Same display name offered by two providers → append the provider so they stay distinguishable.
      const labelCount = {}
      for (const s of out) labelCount[s.label] = (labelCount[s.label] ?? 0) + 1
      for (const s of out) if (labelCount[s.label] > 1) s.label = `${s.label} · ${nameOf(s.key.slice(0, s.key.indexOf('/')))}`
      if (rest.length) out.push({
        key: '__other__', label: `其他 ${rest.length}`, full: '其余模型合计', color: C_OTHER,
        values: days.map((d, i) => rest.reduce((s, k) => s + valOf(d, i, k), 0)),
      })
      return out
    }

    /** SVG plot: stacked / grouped bars or lines, shared axis, gridlines, failure flags, hover.
     *  `estValues` draws a dashed warning line (estimated tokens); `prevValues` a grey dashed
     *  line for the previous equal-length period. `onDayClick(date)` drills into a day. */
    function TrendChart({ days, series, type, hidden, estValues, prevValues, onDayClick, plotRef }) {
      const [hot, setHot] = useState(-1)
      const ownRef = useRef(null)
      const boxRef = plotRef ?? ownRef
      const [W, setW] = useState(560)
      useEffect(() => {
        const el = boxRef.current
        if (!el) return undefined
        const measure = () => { const w = Math.round(el.getBoundingClientRect().width); if (w > 0) setW(w) }
        measure()
        if (typeof ResizeObserver !== 'undefined') {
          const ro = new ResizeObserver(measure)
          ro.observe(el)
          return () => ro.disconnect()
        }
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [])

      const vis = series.filter((s) => !hidden.includes(s.key))
      const n = days.length
      const PL = 40, PR = 6, PT = 12, PH = 150, AX = 20
      const H = PT + PH + AX
      const slot = n ? (W - PL - PR) / n : 0
      const cx = (i) => PL + slot * (i + 0.5)
      const yB = PT + PH
      const max = type === 'stacked'
        ? Math.max(1, ...days.map((_, i) => vis.reduce((s, se) => s + num(se.values[i]), 0)))
        : Math.max(1, ...vis.flatMap((se) => se.values.map(num)))
      const y = (v) => yB - (Math.max(0, num(v)) / max) * PH
      const est = (estValues ?? []).map(num)
      const estOn = est.some((v) => v > 0)
      const prev = (prevValues ?? []).map(num)
      const prevOn = prev.some((v) => v > 0)
      // Clamp to the axis: in grouped/line mode overlay totals can exceed the per-series max.
      const yE = (v) => yB - (Math.min(Math.max(0, num(v)), max) / max) * PH
      const step = Math.max(1, Math.ceil(n / 8))
      const idx = hot >= 0 && hot < n ? hot : n - 1
      const d = days[idx] ?? {}

      const grid = h('g', null,
        h('line', { x1: PL, y1: yB, x2: W - PR, y2: yB, style: { stroke: 'var(--acp-b2)' }, strokeWidth: 1 }),
        h('line', { x1: PL, y1: PT + PH / 2, x2: W - PR, y2: PT + PH / 2, style: { stroke: 'var(--acp-b1)' }, strokeWidth: 1, strokeDasharray: '3 4' }),
        h('line', { x1: PL, y1: PT, x2: W - PR, y2: PT, style: { stroke: 'var(--acp-b1)' }, strokeWidth: 1, strokeDasharray: '3 4' }),
        h('text', { x: PL - 6, y: PT + 3, textAnchor: 'end', fontSize: 9.5, style: { fill: 'var(--acp-faint)' } }, compact(max)),
        h('text', { x: PL - 6, y: PT + PH / 2 + 3, textAnchor: 'end', fontSize: 9.5, style: { fill: 'var(--acp-faint)' } }, compact(max / 2)),
        h('text', { x: PL - 6, y: yB + 3, textAnchor: 'end', fontSize: 9.5, style: { fill: 'var(--acp-faint)' } }, '0'))
      const band = hot >= 0 && hot < n
        ? h('rect', { x: PL + slot * hot, y: PT, width: slot, height: PH, style: { fill: 'var(--acp-in)', fillOpacity: 0.07 }, pointerEvents: 'none' })
        : null

      const marks = []
      if (type === 'stacked') {
        const bw = Math.max(1, Math.min(slot * 0.66, 40))
        for (let i = 0; i < n; i++) {
          let acc = 0
          for (const se of vis) {
            const v = num(se.values[i])
            if (v <= 0) continue
            const hh = (v / max) * PH
            marks.push(h('rect', { key: `s${i}-${se.key}`, x: cx(i) - bw / 2, y: yB - acc - hh, width: bw, height: Math.max(0.5, hh), rx: 1.5, style: { fill: se.color, fillOpacity: 0.92 }, pointerEvents: 'none' }))
            acc += hh
          }
        }
      } else if (type === 'grouped') {
        const m = Math.max(1, vis.length)
        const gw = Math.max(1, Math.min((slot * 0.82) / m, 24))
        for (let i = 0; i < n; i++) {
          const startX = PL + slot * i + (slot - gw * m) / 2
          vis.forEach((se, j) => {
            const v = num(se.values[i])
            if (v <= 0) return
            const hh = (v / max) * PH
            marks.push(h('rect', { key: `g${i}-${se.key}`, x: startX + j * gw, y: yB - hh, width: Math.max(1, gw - 1), height: Math.max(0.5, hh), rx: 1.5, style: { fill: se.color, fillOpacity: 0.92 }, pointerEvents: 'none' }))
          })
        }
      } else {
        for (const se of vis) {
          const pts = days.map((_, i) => `${cx(i).toFixed(1)},${y(se.values[i]).toFixed(1)}`).join(' ')
          marks.push(h('polyline', { key: `l${se.key}`, points: pts, fill: 'none', style: { stroke: se.color }, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke', pointerEvents: 'none' }))
        }
        if (hot >= 0 && hot < n) for (const se of vis) {
          marks.push(h('circle', { key: `d${se.key}`, cx: cx(hot), cy: y(se.values[hot]), r: 3.4, style: { fill: se.color, stroke: 'var(--acp-card)' }, strokeWidth: 1.5, pointerEvents: 'none' }))
        }
      }
      if (estOn) {
        const pts = days.map((_, i) => `${cx(i).toFixed(1)},${yE(est[i]).toFixed(1)}`).join(' ')
        marks.push(h('polyline', { key: 'est', points: pts, fill: 'none', style: { stroke: 'var(--acp-warn)' }, strokeWidth: 1.6, strokeDasharray: '5 4', strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke', pointerEvents: 'none', opacity: 0.9 }))
        if (hot >= 0 && hot < n && num(est[hot]) > 0) marks.push(h('circle', { key: 'estd', cx: cx(hot), cy: yE(est[hot]), r: 3, style: { fill: 'var(--acp-warn)', stroke: 'var(--acp-card)' }, strokeWidth: 1.5, pointerEvents: 'none' }))
      }
      if (prevOn) {
        const pts = days.map((_, i) => `${cx(i).toFixed(1)},${yE(prev[i]).toFixed(1)}`).join(' ')
        marks.push(h('polyline', { key: 'prev', points: pts, fill: 'none', style: { stroke: C_OTHER }, strokeWidth: 1.4, strokeDasharray: '2 3', strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke', pointerEvents: 'none', opacity: 0.85 }))
        if (hot >= 0 && hot < n && num(prev[hot]) > 0) marks.push(h('circle', { key: 'prevd', cx: cx(hot), cy: yE(prev[hot]), r: 3, style: { fill: C_OTHER, stroke: 'var(--acp-card)' }, strokeWidth: 1.5, pointerEvents: 'none' }))
      }
      const flags = days.map((dd, i) => num(dd.failed) > 0
        ? h('circle', { key: `f${i}`, cx: cx(i), cy: 4, r: 2.6, style: { fill: 'var(--acp-err)' }, pointerEvents: 'none' })
        : null)
      const axis = days.map((x, i) => (i % step === 0 || i === n - 1)
        ? h('text', { key: `a${i}`, x: cx(i), y: yB + 14, textAnchor: 'middle', fontSize: 10, style: { fill: 'var(--acp-faint)' } }, x.date.slice(5))
        : null)
      const hit = days.map((_, i) => h('rect', { key: `hit${i}`, x: PL + slot * i, y: PT, width: slot, height: PH, fill: 'transparent', pointerEvents: 'all', style: { cursor: onDayClick ? 'pointer' : 'crosshair' }, onMouseEnter: () => setHot(i), onClick: onDayClick ? () => onDayClick(days[i].date) : undefined }))
      const emptyHint = vis.length === 0
        ? h('text', { x: (PL + W - PR) / 2, y: PT + PH / 2, textAnchor: 'middle', fontSize: 11, style: { fill: 'var(--acp-muted)' } }, '点击图例显示系列')
        : null

      return h(Fragment, null,
        h('div', { className: 'acp-plot', ref: boxRef, onMouseLeave: () => setHot(-1) },
          h('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': '每日 Token 趋势', style: { display: 'block' } },
            grid, band, ...marks, ...flags, emptyHint, ...axis, ...hit)),
        h('div', { className: 'acp-readout' },
          h('span', null, h('b', null, d.date ?? '-')),
          h('span', null, '合计 ', h('b', null, compact(num(d.inputTokens) + num(d.outputTokens)))),
          estOn && num(est[idx]) > 0 ? h('span', { title: '估算轮次的 Token（字符 ÷ 4），图中虚线' }, '估算 ', h('b', { style: { color: 'var(--acp-warn)' } }, compact(est[idx]))) : null,
          prevOn && num(prev[idx]) > 0 ? h('span', { title: '上一个等长周期同日序的 Token 合计，灰色虚线' }, '上期 ', h('b', { style: { color: C_OTHER } }, compact(prev[idx]))) : null,
          ...vis.filter((se) => num(se.values[idx]) > 0).map((se) => h('span', { key: se.key },
            h('i', { style: { display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: se.color, marginRight: 4, verticalAlign: 'middle' } }),
            se.label, ' ', h('b', null, compact(se.values[idx])))),
          h('span', null, '轮次 ', h('b', null, n0(d.turns))),
          h('span', null, '成功率 ', h('b', null, pct(num(d.ok), num(d.turns)))),
          num(d.failed) ? h('span', null, '失败 ', h('b', { style: { color: 'var(--acp-err)' } }, n0(d.failed))) : null))
    }

    function DailyTrendCard({ days, recent, colorOf, nameOf, modelOf, type: typeProp, dim: dimProp, onType, onDim, prevValues, onDayClick, drillPanel, card }) {
      const [typeLocal, setTypeLocal] = useState('stacked')
      const [dimLocal, setDimLocal] = useState('io')
      const type = typeProp ?? typeLocal
      const dim = dimProp ?? dimLocal
      const setType = onType ?? setTypeLocal
      const setDim = onDim ?? setDimLocal
      const [hidden, setHidden] = useState([])
      const plotRef = useRef(null)
      const hasSlices = days.some((d) => d.models && Object.keys(d.models).length > 0)
      const modelDays = hasSlices ? null : recentModelDays(days, recent)
      const series = seriesFor(days, dim, colorOf, nameOf, modelDays, modelOf)
      const hasEstField = days.some((d) => 'estimatedTokens' in d)
      const estValues = hasEstField ? days.map((d) => num(d.estimatedTokens)) : recentEstimatedDays(days, recent)
      const estTotal = estValues.reduce((s, v) => s + num(v), 0)
      const prevOn = (prevValues ?? []).some((v) => num(v) > 0)
      const hasTurns = days.some((d) => num(d.turns) > 0)
      const showFail = days.some((d) => num(d.failed) > 0)
      const toggle = (key) => setHidden((cur) => cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key])
      const seg = (opts, cur, set) => h('div', { className: 'acp-seg' }, ...opts.map(([v, label, title]) => h('button', {
        key: v, type: 'button', title, className: cur === v ? 'on' : '', 'aria-pressed': String(cur === v),
        onClick: () => { set(v); setHidden([]) },
      }, label)))
      const doExport = (kind) => exportChart(plotRef.current?.querySelector('svg'), kind, `acp-trend-${dateStr(Date.now())}`)
      return h(Card, { className: 's8', title: '每日 Token 趋势', ...card },
        h('div', { className: 'acp-tt' },
          h('span', { className: 'acp-tt-l' }, '图表'), seg(TYPES, type, setType),
          h('span', { className: 'acp-sp' }),
          h('span', { className: 'acp-tt-l' }, '维度'), seg(DIMS, dim, setDim),
          h('button', { type: 'button', className: 'acp-btn', title: '把当前图表存为 SVG 文件', onClick: () => doExport('svg') }, 'SVG'),
          h('button', { type: 'button', className: 'acp-btn', title: '把当前图表存为 PNG 图片（2 倍清晰度）', onClick: () => doExport('png') }, 'PNG')),
        hasTurns ? h(TrendChart, { days, series, type, hidden, estValues, prevValues, onDayClick, plotRef }) : h(Empty, { text: '所选范围内还没有调用记录' }),
        hasTurns ? h('div', { className: 'acp-legend wrap' },
          ...series.map((s) => h('button', { key: s.key, type: 'button', className: `acp-lg${hidden.includes(s.key) ? ' off' : ''}`, title: `${s.full} · 点击${hidden.includes(s.key) ? '显示' : '隐藏'}`, onClick: () => toggle(s.key) },
            h('i', { style: { background: s.color } }), s.label)),
          showFail ? h('span', { className: 'acp-lg', style: { cursor: 'default' }, title: '当天有失败的调用' }, h('i', { style: { background: 'var(--acp-err)', borderRadius: '50%' } }), '有失败') : null,
          estTotal > 0 ? h('span', { className: 'acp-lg', style: { cursor: 'default' }, title: '虚线为估算轮次的 Token 合计（CLI 未上报用量，按字符 ÷ 4）' }, h('i', { style: { width: 12, height: 0, borderTop: '2px dashed var(--acp-warn)', background: 'transparent', borderRadius: 0 } }), '估算(虚线)') : null,
          prevOn ? h('span', { className: 'acp-lg', style: { cursor: 'default' }, title: '上一个等长周期的每日 Token 合计，按日序对齐' }, h('i', { style: { width: 12, height: 0, borderTop: '2px dashed ' + C_OTHER, background: 'transparent', borderRadius: 0 } }), '上期(虚线)') : null,
          hidden.length ? h('button', { type: 'button', className: 'acp-btn', style: { padding: '1px 8px', fontSize: 11 }, onClick: () => setHidden([]) }, '全部显示') : null) : null,
        hasTurns && onDayClick ? h('div', { className: 'acp-note' }, '提示：点击某天的柱子 / 数据点可下钻当天 24h 分布与会话明细。') : null,
        drillPanel ?? null)
    }
    function HourChart({ hours, tall }) {
      const hs = hours.length === 24 ? hours : Array.from({ length: 24 }, () => 0)
      const max = Math.max(1, ...hs)
      const total = hs.reduce((a, b) => a + b, 0)
      const peak = hs.indexOf(Math.max(...hs))
      return h(Fragment, null,
        h('div', { className: `acp-bars${tall ? '' : ' sm'}` }, ...hs.map((v, i) => h('div', { key: i, className: 'col', title: `${pad(i)}:00–${pad(i)}:59：${v} 轮` },
          v > 0 ? h('span', { className: `seg ${i === peak ? 'pk' : 'h'}`, style: { height: `${(v / max) * 100}%`, width: '80%', animationDelay: `${i * 12}ms` } }) : null))),
        h('div', { className: 'acp-axis' }, ...hs.map((_, i) => h('span', { key: i }, i % 6 === 0 ? String(i) : ''))),
        h('div', { className: 'acp-note' }, total ? `高峰 ${pad(peak)}:00 · ${hs[peak]} 轮 · 共 ${total} 轮` : '暂无数据'))
    }
    function Heatmap({ cells, metric = 'turns' }) {
      const val = (c) => metric === 'tokens' ? num(c.tokens) : metric === 'failed' ? num(c.failed) : num(c.turns)
      const max = Math.max(1, ...cells.map(val))
      const lead = cells.length ? (cells[0].dow + 6) % 7 : 0
      const lvl = (t) => (t === 0 ? 0 : Math.min(4, Math.ceil((t / max) * 4)))
      const MIX = [0, 25, 48, 72, 100]
      const HUE = metric === 'failed' ? 'var(--acp-err)' : metric === 'tokens' ? 'var(--acp-out)' : 'var(--acp-in)'
      const bg = (l) => (l ? `color-mix(in srgb, ${HUE} ${MIX[l]}%, var(--acp-sub))` : 'var(--acp-sub)')
      const active = cells.filter((c) => val(c) > 0).length
      const total = cells.reduce((s, c) => s + val(c), 0)
      const unit = metric === 'tokens' ? 'Token' : metric === 'failed' ? '次失败' : '轮'
      return h(Fragment, null,
        h('div', { className: 'acp-heat-wrap' },
          h('div', { className: 'acp-heat-days' }, ...['一', '', '三', '', '五', '', '日'].map((d, i) => h('span', { key: i }, d))),
          h('div', { className: 'acp-heat' },
            ...Array.from({ length: lead }, (_, i) => h('i', { key: `p${i}`, className: 'pad' })),
            ...cells.map((c) => h('i', { key: c.date, title: `${c.date}：${c.turns} 轮 · ${compact(c.tokens)} Token${c.failed ? ` · 失败 ${c.failed}` : ''}`, style: { background: bg(lvl(val(c))) } })))),
        h('div', { className: 'acp-heat-leg' }, '少', ...[0, 1, 2, 3, 4].map((l) => h('i', { key: l, style: { background: bg(l) } })), '多',
          h('span', { style: { marginLeft: 'auto' } }, `活跃 ${active} 天 · ${metric === 'tokens' ? compact(total) : n0(total)} ${unit}`)))
    }
    function Donut({ items, center, sub, onPick }) {
      const [hot, setHot] = useState(null)
      const total = items.reduce((s, x) => s + x.value, 0)
      let acc = 0
      const segs = total > 0 ? items.filter((x) => x.value > 0).map((x) => { const p = (x.value / total) * 100; const s = { ...x, p, off: acc }; acc += p; return s }) : []
      const gap = segs.length > 1 ? 0.9 : 0
      const focus = segs.find((s) => s.key === hot)
      return h('div', { className: 'acp-donut' },
        h('svg', { viewBox: '0 0 42 42', width: 136, height: 136, style: { flex: 'none' }, role: 'img', 'aria-label': '提供方占比' },
          h('circle', { cx: 21, cy: 21, r: 15.915, fill: 'none', strokeWidth: 6, style: { stroke: 'var(--acp-sub)' } }),
          ...segs.map((s, i) => {
            const len = Math.max(0.3, s.p - gap)
            return h('circle', {
              key: s.key, cx: 21, cy: 21, r: 15.915, fill: 'none', stroke: s.color, strokeWidth: hot === s.key ? 7.6 : 6,
              pathLength: 100, strokeDasharray: `${len} ${100 - len}`, strokeDashoffset: 25 - s.off,
              className: `acp-arc${onPick ? ' click' : ''}`, style: { animationDelay: `${i * 80}ms`, opacity: hot && hot !== s.key ? 0.45 : 1 },
              onMouseEnter: () => setHot(s.key), onMouseLeave: () => setHot(null),
              onClick: onPick ? () => onPick(s.key) : undefined,
            })
          }),
          h('text', { x: 21, y: 21.5, textAnchor: 'middle', fontSize: 6.2, fontWeight: 700, style: { fill: 'var(--acp-fg)' } }, focus ? `${Math.round(focus.p)}%` : center),
          h('text', { x: 21, y: 27, textAnchor: 'middle', fontSize: 3.5, style: { fill: 'var(--acp-muted)' } }, focus ? focus.label : sub)),
        h('div', { className: 'acp-leg' }, ...items.map((x) => h('div', { key: x.key, title: onPick ? `${x.title ?? x.label} · 点击筛选全页` : x.title, className: `row${hot === x.key ? ' hot' : ''}${onPick ? ' click' : ''}`, onMouseEnter: () => setHot(x.key), onMouseLeave: () => setHot(null), onClick: onPick ? () => onPick(x.key) : undefined },
          h('i', { style: { background: x.color } }), h('span', { className: 'nm' }, x.label),
          h('span', { className: 'n' }, x.text ?? compact(x.value)), h('span', { className: 'p' }, total ? `${Math.round((x.value / total) * 100)}%` : '-')))))
    }
    function Rank({ rows, colorOf, nameOf, modelOf = rawModelOf, onPick, active }) {
      const top = [...rows].sort((a, b) => tokOf(b) - tokOf(a) || b.turns - a.turns).slice(0, 8)
      const max = Math.max(1, ...top.map(tokOf))
      return h('div', { className: 'acp-rank pick' }, ...top.map((m, i) => h('div', {
        key: `${m.provider}/${m.model}`,
        className: `r${onPick ? ' click' : ''}${active === `${m.provider}/${m.model}` ? ' sel' : ''}`,
        title: onPick ? (active === `${m.provider}/${m.model}` ? '点击取消全页筛选' : '点击让全页只看这个模型') : undefined,
        onClick: onPick ? () => onPick(m.provider, m.model) : undefined,
      },
        h('span', { className: `no${i < 3 ? ' top' : ''}` }, String(i + 1)),
        h('span', { className: 'nm', title: `${m.provider}/${m.model}` }, modelOf(m.provider, m.model), h('small', null, nameOf(m.provider))),
        h('span', { className: 'val' }, h('b', null, compact(tokOf(m))), ` · ${m.turns} 轮`),
        h('span', { className: 'track' }, h('i', { style: { width: `${Math.max(2, (tokOf(m) / max) * 100)}%`, background: `linear-gradient(90deg, color-mix(in srgb, ${colorOf(m.provider)} 55%, #fff), ${colorOf(m.provider)})`, animationDelay: `${i * 60}ms` } })))))
    }

    // ── scan installed ACP CLIs → provider editor (lib/discover.js) ──
    const PERM_OPTS = [
      ['allow', '允许', '可改文件、跑命令，每次单次批准（默认）'],
      ['read', '只读工具', '只批准读取 / 搜索类工具'],
      ['reject', '只读', '不改文件、不跑命令'],
    ]
    const VIA_OPTS = [['args', '命令行 --model'], ['configOption', 'ACP 切换']]
    const PROVIDER_ID_RE = /^[A-Za-z0-9][\w.-]{0,63}$/
    const FALLBACK_DEFAULTS = { modelArgs: ['--model', '{model}'], permission: 'allow', modelVia: 'args', startupTimeoutMs: 60000, promptTimeoutMs: 1800000, idleTimeoutMs: 600000, reuseSessions: true, maxSessions: 8, resumeSessions: true, images: true, promptRetries: 1, contextWindow: 200000, modelDiscoveryBackoffMs: 60000, modelDiscoveryMaxBackoffMs: 1800000, rateInName: true, askUser: false }
    const FORM_KEYS = new Set(['displayName', 'command', 'args', 'permission', 'modelVia', 'modelArgs', 'env', 'startupTimeoutMs', 'promptTimeoutMs', 'idleTimeoutMs', 'maxSessions', 'promptRetries', 'contextWindow', 'reuseSessions', 'resumeSessions', 'images', 'models', 'mode',
      'effort', 'askUser', 'modelDiscoveryBackoffMs', 'modelDiscoveryMaxBackoffMs', 'rateInName'])
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const hueOf = (s) => { let x = 7; for (const ch of String(s)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return PALETTE[x % PALETTE.length] }
    const splitArgs = (s) => (String(s ?? '').trim() ? String(s).trim().split(/\s+/) : [])
    const pick = (v, d) => (v === undefined || v === null ? d : v)
    /** The spec to edit for a configured provider: its raw config when the host sends it. */
    const editSpecOf = (p) => p?.raw ?? (p ? { displayName: short(p.displayName), command: p.command, args: p.args, permission: p.permission, ...(p.modelVia === 'configOption' ? { modelVia: 'configOption' } : {}) } : {})

    function toForm(id, spec, d) {
      const s = spec ?? {}
      return {
        id: id ?? '', displayName: s.displayName ?? '', command: s.command ?? '', args: (s.args ?? []).join(' '),
        permission: pick(s.permission, d.permission), modelVia: pick(s.modelVia, d.modelVia),
        modelArgs: (s.modelArgs ?? d.modelArgs).join(' '),
        env: Object.entries(s.env ?? {}).map(([k, v]) => [k, String(v)]),
        startupS: String(Math.round(pick(s.startupTimeoutMs, d.startupTimeoutMs) / 1000)),
        promptMin: String(Math.round(pick(s.promptTimeoutMs, d.promptTimeoutMs) / 60000)),
        idleMin: String(Math.round(pick(s.idleTimeoutMs, d.idleTimeoutMs) / 60000)),
        maxSessions: String(pick(s.maxSessions, d.maxSessions)),
        promptRetries: String(pick(s.promptRetries, d.promptRetries)),
        contextWindow: String(pick(s.contextWindow, d.contextWindow)),
        reuseSessions: pick(s.reuseSessions, d.reuseSessions), resumeSessions: pick(s.resumeSessions, d.resumeSessions), images: pick(s.images, d.images),
        models: (s.models ?? []).join(', '), mode: s.mode ?? '',
        effort: typeof s.effort === 'string' ? s.effort : '', askUser: pick(s.askUser, d.askUser) === true,
        backoffS: String(Math.round(pick(s.modelDiscoveryBackoffMs, d.modelDiscoveryBackoffMs) / 1000)),
        maxBackoffMin: String(Math.round(pick(s.modelDiscoveryMaxBackoffMs, d.modelDiscoveryMaxBackoffMs) / 60000)),
        rateInName: pick(s.rateInName, d.rateInName),
        // Keys this form has no field for (approvals, usageCommand, …) survive an edit unchanged.
        extra: Object.fromEntries(Object.entries(s).filter(([k]) => !FORM_KEYS.has(k))),
      }
    }
    function fromForm(f, d) {
      const errors = {}
      const int = (key, v, mul, min, max) => {
        const n = Number(String(v).trim())
        if (String(v).trim() === '' || !Number.isInteger(n) || n < min || n > max) { errors[key] = `${min}–${max} 的整数`; return undefined }
        return n * mul
      }
      if (!PROVIDER_ID_RE.test(f.id.trim())) errors.id = '字母或数字开头，可含 . _ -'
      if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(f.command.trim())) errors.command = '写可执行文件的绝对路径（/… 或 C:\\…）'
      const env = {}
      f.env.forEach(([k, v], i) => {
        const key = k.trim()
        if (!key && !v) return
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) errors[`env${i}`] = '变量名只能是字母、数字、下划线'
        else env[key] = v
      })
      const spec = {
        ...f.extra,
        displayName: f.displayName.trim() || undefined,
        command: f.command.trim(), args: splitArgs(f.args), permission: f.permission,
        ...(f.modelVia === 'configOption' ? { modelVia: 'configOption' } : { modelArgs: splitArgs(f.modelArgs) }),
        ...(Object.keys(env).length ? { env } : {}),
        // Basic fields are always written, so the saved config shows what the provider runs with.
        startupTimeoutMs: int('startupS', f.startupS, 1000, 1, 600),
        promptTimeoutMs: int('promptMin', f.promptMin, 60000, 1, 600),
        idleTimeoutMs: int('idleMin', f.idleMin, 60000, 1, 600),
        maxSessions: int('maxSessions', f.maxSessions, 1, 1, 64),
        reuseSessions: f.reuseSessions, resumeSessions: f.resumeSessions,
      }
      // Advanced fields: written only when they differ from the defaults.
      const retries = int('promptRetries', f.promptRetries, 1, 0, 3)
      if (retries !== undefined && retries !== d.promptRetries) spec.promptRetries = retries
      const cw = int('contextWindow', f.contextWindow, 1, 1000, 10_000_000)
      if (cw !== undefined && cw !== d.contextWindow) spec.contextWindow = cw
      if (f.images !== d.images) spec.images = f.images
      const models = f.models.split(/[,\s]+/).filter(Boolean)
      if (models.length) spec.models = models
      if (f.mode.trim()) spec.mode = f.mode.trim()
      // Reasoning effort / askUser / discovery backoff / rate suffix: written only when set or non-default.
      const effort = f.effort.trim()
      if (effort.length > 64 || /[\u0000-\u001f\u007f]/.test(effort)) errors.effort = '最多 64 个字符，不能有控制字符'
      else if (effort) spec.effort = effort
      if (f.askUser && f.permission !== 'allow') spec.askUser = true
      const backoff = int('backoffS', f.backoffS, 1000, 0, 3600)
      if (backoff !== undefined && backoff !== d.modelDiscoveryBackoffMs) spec.modelDiscoveryBackoffMs = backoff
      const maxBackoff = int('maxBackoffMin', f.maxBackoffMin, 60000, 1, 1440)
      if (maxBackoff !== undefined && maxBackoff !== d.modelDiscoveryMaxBackoffMs) spec.modelDiscoveryMaxBackoffMs = maxBackoff
      if (f.rateInName !== d.rateInName) spec.rateInName = f.rateInName
      for (const k of Object.keys(spec)) if (spec[k] === undefined) delete spec[k]
      return { spec, errors }
    }
    const yScalar = (v) => (typeof v === 'string'
      ? (/^[A-Za-z_./-][\w ./:@+-]*$/.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v) && !/:\s|\s$|:$/.test(v) ? v : JSON.stringify(v))
      : String(v))
    function yamlOf(id, spec) {
      const out = ['- id: llm-acp', '  config:', '    providers:', `      ${id || '<provider>'}:`]
      for (const [k, v] of Object.entries(spec)) {
        if (Array.isArray(v)) out.push(`        ${k}: [${v.map(yScalar).join(', ')}]`)
        else if (v && typeof v === 'object') { out.push(`        ${k}:`); for (const [k2, v2] of Object.entries(v)) out.push(`          ${k2}: ${v2 && typeof v2 === 'object' ? JSON.stringify(v2) : yScalar(v2)}`) }
        else out.push(`        ${k}: ${yScalar(v)}`)
      }
      return out.join('\n')
    }

    function Field({ label, hint, error, full, children }) {
      return h('div', { className: `acp-fld${full ? ' full' : ''}${error ? ' err' : ''}` },
        h('label', null, label), children,
        error ? h('div', { className: 'errt' }, error) : hint ? h('div', { className: 'hint' }, hint) : null)
    }
    const Suffix = ({ unit, children }) => h('div', { className: 'acp-sfx' }, children, h('span', null, unit))
    function Toggle({ checked, label, sub, onChange }) {
      return h('div', { className: 'acp-tg' },
        h(Switch, { checked, label, onChange }),
        h('div', { onClick: () => onChange(!checked) }, h('b', null, label), sub ? h('small', null, sub) : null))
    }
    function ProbeBox({ pr, via, onAdopt }) {
      if (!pr) return null
      if (pr.loading) return h('div', { className: 'acp-probe' }, h('span', { className: 'acp-spin' }), 'ACP 握手中…不发提示词、不花 Token')
      if (!pr.ok) {
        return h('div', { className: 'acp-probe fail' },
          h('b', null, `握手失败${pr.code ? ` · ${pr.code}` : ''}`),
          h('div', { className: 'msg' }, pr.message ?? ''),
          pr.hint ? h('div', { className: 'msg' }, '提示：', pr.hint) : null)
      }
      const ids = (pr.models ?? []).map((m) => m.id)
      return h('div', { className: 'acp-probe ok' },
        h('div', { className: 'acp-row', style: { gap: 6 } },
          h('b', null, `握手成功 · ${dur(pr.ms)}`),
          h(Chip, { kind: 'ok' }, `${ids.length} 个模型`),
          h(Chip, null, pr.image ? '支持图片' : '不支持图片'),
          pr.loadSession ? h(Chip, null, '可接回会话') : null,
          h(Chip, { kind: 'brand' }, `建议：${pr.modelVia === 'configOption' ? 'ACP 切换' : '命令行 --model'}`),
          pr.modelVia && via !== pr.modelVia ? h('button', { type: 'button', className: 'acp-btn', onClick: onAdopt }, '采用建议') : null),
        ids.length ? h('div', { className: 'acp-mchips' }, ...ids.slice(0, 24).map((id) => h('span', { key: id }, id)), ids.length > 24 ? h('span', { className: 'more' }, `+${ids.length - 24}`) : null) : null)
    }

    /** Add or edit one provider. Prefilled with the recommended basic config; every field editable. */
    function ProviderEditor({ init, defaults, takenIds, onClose, onSaved }) {
      const d = { ...FALLBACK_DEFAULTS, ...(defaults ?? {}) }
      const editing = init.mode === 'edit'
      const [f, setF] = useState(() => toForm(init.id, init.spec, d))
      const [viaTouched, setViaTouched] = useState(false)
      const [tried, setTried] = useState(false)
      const [pr, setPr] = useState(null)
      const [saving, setSaving] = useState(false)
      const [err, setErr] = useState('')
      const [adv, setAdv] = useState(false)
      const [yamlOpen, setYamlOpen] = useState(false)
      const set = (patch) => setF((c) => ({ ...c, ...patch }))
      const { spec, errors } = fromForm(f, d)
      if (!editing && f.id.trim() && takenIds.includes(f.id.trim())) errors.id = '这个名字已经有 provider 在用了'
      const bad = Object.keys(errors).length > 0
      // Show a field's error once the user typed there or tried to save.
      const errOf = (key, value) => (tried || String(value ?? '').trim() !== '' ? errors[key] : undefined)
      useEffect(() => {
        const k = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', k)
        return () => window.removeEventListener('keydown', k)
      }, [])
      const doProbe = async () => {
        setPr({ loading: true })
        try {
          const j = await post(R.probe, { spec, recipeModelVia: init.recipeModelVia })
          const r = { ...j.result, modelVia: j.modelVia }
          setPr(r)
          if (r.ok && !editing && !viaTouched && r.modelVia) set({ modelVia: r.modelVia })
        } catch (e) { setPr({ ok: false, message: String(e?.message ?? e) }) }
      }
      const save = async () => {
        setTried(true)
        if (bad) return
        setSaving(true); setErr('')
        try { await post(R.add, { id: f.id.trim(), spec, overwrite: editing }); onSaved(editing ? `已保存 ${f.id.trim()}，插件正在重载` : `已添加 ${f.id.trim()}，插件正在重载`) }
        catch (e) { setErr(String(e?.message ?? e)); setSaving(false) }
      }
      const remove = async () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(`从配置里删除 provider「${f.id}」？还有模型引用写 ${f.id}/<model>，删除后这些引用会报错。`)) return
        setSaving(true); setErr('')
        try { await post(R.remove, { id: f.id }); onSaved(`已删除 ${f.id}，插件正在重载`) }
        catch (e) { setErr(String(e?.message ?? e)); setSaving(false) }
      }
      const inp = (key, props = {}) => h('input', { value: f[key], spellCheck: false, autoComplete: 'off', onChange: (e) => set({ [key]: e.target.value }), ...props })
      const sec = (title, sub, ...children) => h('section', { className: 'acp-ed-sec' }, h('div', { className: 't' }, title, sub ? h('small', null, sub) : null), ...children)
      const name = f.displayName.trim() || f.id.trim() || (f.command.split('/').pop() ?? '')
      const color = hueOf(f.id || f.command || 'x')
      const route = f.id.trim() || '<provider>'
      // Efforts the CLI reported (learned at discovery); none known ⇒ a free-text id.
      const efforts = Array.isArray(init.efforts) ? init.efforts.filter((e) => typeof e?.id === 'string' && e.id !== '') : []
      const effortOpts = [['', 'CLI 默认'], ...efforts.map((e) => [e.id, e.name || e.id]),
        ...(f.effort.trim() && !efforts.some((e) => e.id === f.effort.trim()) ? [[f.effort.trim(), `${f.effort.trim()}（CLI 未提供）`]] : [])]
      return h('div', { className: 'acp-modal', onClick: onClose },
        h('div', { className: 'acp-modal-box acp-ed', role: 'dialog', 'aria-modal': 'true', 'aria-label': editing ? `编辑 ${name}` : '添加 provider', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'acp-ed-hd' },
            h('div', { className: 'acp-av', style: { '--pc': color } }, (name[0] ?? '+').toUpperCase()),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { className: 'acp-ed-title' }, editing ? `编辑 ${init.title ?? name}` : init.title ? `添加 ${init.title}` : '手动添加 ACP CLI'),
              h('div', { className: 'acp-ed-sub' }, editing ? '保存后写入 profile 配置，插件自动重载' : init.note ? `已按推荐值填好基础配置 · ${init.note}` : '已按推荐值填好基础配置，按需修改即可')),
            h('button', { type: 'button', className: 'acp-x', onClick: onClose, 'aria-label': '关闭', title: '关闭（Esc）' }, '×')),

          h('div', { className: 'acp-ed-body' },
            sec('基础', null,
              h('div', { className: 'acp-ed-grid' },
                h(Field, { label: '显示名', hint: '模型选择器里显示的名字' }, inp('displayName', { placeholder: name || 'Kiro' })),
                h(Field, { label: 'provider 名', error: errOf('id', f.id), hint: editing ? '已接入的 provider 不能改名' : `模型引用写法：${route}/<model>` },
                  inp('id', { placeholder: 'kiro', disabled: editing })),
                h(Field, { label: '可执行文件', full: true, error: errOf('command', f.command), hint: '绝对路径；扫描结果已自动填好' },
                  inp('command', { placeholder: '/Users/you/.local/bin/kiro-cli', className: 'mono' })),
                h(Field, { label: 'ACP 参数', hint: '进入 ACP 模式的参数，空格分隔' }, inp('args', { placeholder: 'acp', className: 'mono' })),
                h(Field, { label: '选模型方式', hint: f.modelVia === 'configOption' ? '建好会话后用 ACP 配置项切换模型' : '启动时把模型拼进命令行' },
                  h('div', { className: 'acp-seg full' }, ...VIA_OPTS.map(([v, l]) => h('button', { key: v, type: 'button', className: f.modelVia === v ? 'on' : '', onClick: () => { setViaTouched(true); set({ modelVia: v }) } }, l)))),
                f.modelVia === 'args' ? h(Field, { label: '模型参数模板', full: true, hint: '{model} 会被替换成模型引用里的模型；<provider>/default 时不传' },
                  inp('modelArgs', { placeholder: '--model {model}', className: 'mono' })) : null)),

            sec('权限', '这个 CLI 能不能改文件、跑命令',
              h('div', { className: 'acp-perm' }, ...PERM_OPTS.map(([v, l, s]) => h('button', {
                key: v, type: 'button', className: f.permission === v ? 'on' : '', 'aria-pressed': String(f.permission === v), onClick: () => set({ permission: v }),
              }, h('b', null, l), h('small', null, s)))),
              f.permission !== 'allow' ? h('div', { className: 'acp-tgs' },
                h(Toggle, { checked: f.askUser, label: '被拒时先问我', sub: '本会拒绝的工具请求先交 DSH 审批，同意一次才放行', onChange: (v) => set({ askUser: v }) })) : null),

            sec('推理强度', '新会话默认用的档位；宿主这一轮选了档位时以宿主为准',
              h(Field, { label: '默认档位', full: true, error: errors.effort,
                hint: efforts.length ? 'CLI 报告的档位；选「CLI 默认」= 不切换' : '还没从 CLI 读到档位（检测连接或用一次后会出现）；可手填档位 id，留空 = 不切换' },
                efforts.length
                  ? h('div', { className: 'acp-seg full' }, ...effortOpts.map(([v, l]) => h('button', { key: v || '_', type: 'button', className: f.effort.trim() === v ? 'on' : '', onClick: () => set({ effort: v }) }, l)))
                  : inp('effort', { placeholder: '不指定（用 CLI 默认）', className: 'mono' }))),

            sec('环境变量', 'node 脚本类 CLI 需要 PATH 里有 node',
              ...f.env.map(([k, v], i) => h('div', { key: i, className: `acp-env${errors[`env${i}`] ? ' err' : ''}` },
                h('input', { value: k, placeholder: 'NAME', spellCheck: false, className: 'mono', onChange: (e) => set({ env: f.env.map((r, j) => (j === i ? [e.target.value, r[1]] : r)) }) }),
                h('input', { value: v, placeholder: 'value', spellCheck: false, className: 'mono', onChange: (e) => set({ env: f.env.map((r, j) => (j === i ? [r[0], e.target.value] : r)) }) }),
                h('button', { type: 'button', className: 'acp-x sm', 'aria-label': '删除变量', onClick: () => set({ env: f.env.filter((_, j) => j !== i) }) }, '×'))),
              f.env.some((_, i) => errors[`env${i}`]) ? h('div', { className: 'acp-fld err' }, h('div', { className: 'errt' }, '变量名只能是字母、数字、下划线')) : null,
              h('button', { type: 'button', className: 'acp-btn ghost', onClick: () => set({ env: [...f.env, ['', '']] }) }, '+ 添加变量')),

            sec('超时与会话', null,
              h('div', { className: 'acp-ed-grid g4' },
                h(Field, { label: '启动超时', error: errors.startupS }, h(Suffix, { unit: '秒' }, inp('startupS', { inputMode: 'numeric' }))),
                h(Field, { label: '单轮上限', error: errors.promptMin }, h(Suffix, { unit: '分钟' }, inp('promptMin', { inputMode: 'numeric' }))),
                h(Field, { label: '无输出判卡死', error: errors.idleMin }, h(Suffix, { unit: '分钟' }, inp('idleMin', { inputMode: 'numeric' }))),
                h(Field, { label: '最多热会话', error: errors.maxSessions }, h(Suffix, { unit: '个' }, inp('maxSessions', { inputMode: 'numeric' })))),
              h('div', { className: 'acp-tgs' },
                h(Toggle, { checked: f.reuseSessions, label: '复用热会话', sub: '省掉每轮冷启动', onChange: (v) => set({ reuseSessions: v }) }),
                h(Toggle, { checked: f.resumeSessions, label: '接回原生会话', sub: '重启后用 session/load 接回', onChange: (v) => set({ resumeSessions: v }) }))),

            h('section', { className: `acp-ed-sec fold${adv ? ' open' : ''}` },
              h('button', { type: 'button', className: 't', onClick: () => setAdv(!adv), 'aria-expanded': String(adv) }, h('span', { className: 'car' }, adv ? '▾' : '▸'), '高级', h('small', null, '一般不用改')),
              adv ? h('div', { className: 'acp-ed-grid' },
                h(Field, { label: '失败重试', error: errors.promptRetries, hint: '只在还没输出任何文本时重试，0–3' }, inp('promptRetries', { inputMode: 'numeric' })),
                h(Field, { label: '上下文窗口', error: errors.contextWindow, hint: '报给宿主的 token 数' }, inp('contextWindow', { inputMode: 'numeric' })),
                h(Field, { label: '静态模型列表', hint: '留空 = 自动发现；逗号分隔' }, inp('models', { placeholder: 'default', className: 'mono' })),
                h(Field, { label: 'ACP mode', hint: '会话建好后切换到的 mode，如 plan' }, inp('mode', { placeholder: '不切换', className: 'mono' })),
                h(Field, { label: '发现失败退避', error: errors.backoffS, hint: '模型发现失败后多久内不再起 CLI，连续失败翻倍；0 = 不退避' }, h(Suffix, { unit: '秒' }, inp('backoffS', { inputMode: 'numeric' }))),
                h(Field, { label: '退避上限', error: errors.maxBackoffMin, hint: '翻倍到此为止；未登录时直接等这么久' }, h(Suffix, { unit: '分钟' }, inp('maxBackoffMin', { inputMode: 'numeric' }))),
                h('div', { className: 'acp-fld full' }, h(Toggle, { checked: f.rateInName, label: '名字后显示积分倍率', sub: '如「Hy3 · 0x 免费」；codebuddy / kiro-cli 自动读取', onChange: (v) => set({ rateInName: v }) })),
                h('div', { className: 'acp-fld full' }, h(Toggle, { checked: f.images, label: '发送图片', sub: 'CLI 支持时把图片作为 ACP 图片块发过去', onChange: (v) => set({ images: v }) }))) : null),

            h(ProbeBox, { pr, via: f.modelVia, onAdopt: () => { setViaTouched(true); set({ modelVia: pr.modelVia }) } }),

            h('section', { className: `acp-ed-sec fold${yamlOpen ? ' open' : ''}` },
              h('button', { type: 'button', className: 't', onClick: () => setYamlOpen(!yamlOpen), 'aria-expanded': String(yamlOpen) }, h('span', { className: 'car' }, yamlOpen ? '▾' : '▸'), '配置预览', h('small', null, '保存后写进 cordis.patch.yml 的就是这段')),
              yamlOpen ? h('pre', { className: 'acp-yaml' }, yamlOf(f.id.trim(), spec)) : null),

            err ? h('div', { className: 'acp-probe fail' }, h('b', null, '保存失败'), h('div', { className: 'msg' }, err)) : null),

          h('div', { className: 'acp-ed-ft' },
            h('button', { type: 'button', className: 'acp-btn', disabled: !!errors.command || pr?.loading || saving, onClick: doProbe, title: '做一次 ACP 握手：不发提示词、不花 Token' }, pr?.loading ? '检测中…' : '检测连接'),
            h('span', { className: 'hint' }, pr?.ok ? '✓ 已检测' : editing ? '' : '建议先检测再添加'),
            h('span', { style: { flex: 1 } }),
            editing ? h('button', { type: 'button', className: 'acp-btn danger', disabled: saving, onClick: remove }, '删除') : null,
            h('button', { type: 'button', className: 'acp-btn', disabled: saving, onClick: onClose }, '取消'),
            h('button', { type: 'button', className: 'acp-btn pri', disabled: saving || (tried && bad), onClick: save }, saving ? '保存中…' : editing ? '保存' : '添加'))))
    }

    // Scan state lives outside the card: switching to another page and back (or opening the
    // right-sidebar console next to the page) reuses the last scan instead of re-running it.
    // Only the very first mount scans by itself; after that it is the 「重新扫描」 button, plus a
    // quiet refresh when a provider is added or removed so the tiles' 已接入 state stays right.
    const discStore = createStore({ res: null, err: '', loading: false, visible: false, known: null, gen: 0 })
    let discFlight = null
    // The one-by-one reveal is time-based (when it started, for which scan generation), so it is
    // shared by every mounted card, survives StrictMode double effects, and is not replayed on
    // a later remount once it has finished.
    let discRevealAt = { gen: -1, t: 0 }
    const REVEAL_MS = 110
    const reducedMotion = () => { try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }
    function runDiscover({ known, visible }) {
      if (discFlight) return discFlight // one scan at a time, shared by every card
      discStore.set({ ...discStore.get(), loading: true, visible, err: '' })
      discFlight = (async () => {
        try {
          const res = await getJson(R.discover)
          const s = discStore.get()
          if (visible && !reducedMotion()) discRevealAt = { gen: s.gen + 1, t: Date.now() }
          discStore.set({ ...s, res, err: '', loading: false, visible: false, known, gen: s.gen + 1 })
        } catch (e) {
          discStore.set({ ...discStore.get(), err: String(e?.message ?? e), loading: false, visible: false })
        } finally { discFlight = null }
      })()
      return discFlight
    }
    /** Tile-shaped placeholder while scanning, and for tiles not revealed yet. */
    function SkelTile({ i }) {
      const bar = (w, ht, r = 5) => h('div', { className: 'acp-skel', style: { height: ht, width: w, borderRadius: r } })
      return h('div', { className: 'acp-tile acp-skel-tile', 'aria-hidden': true, style: { '--d': `${(i % 5) * 120}ms` } },
        h('div', { className: 'acp-row', style: { gap: 9, flexWrap: 'nowrap' } },
          h('div', { className: 'acp-skel', style: { width: 30, height: 30, borderRadius: 9, flex: 'none' } }),
          h('div', { style: { flex: 1, minWidth: 0, display: 'grid', gap: 6 } }, bar('52%', 11), bar('86%', 9))),
        h('div', { className: 'acp-row', style: { gap: 6 } }, bar(54, 18, 9), bar(86, 18, 9), bar(58, 18, 9)),
        bar('72%', 9),
        h('div', { className: 'ft' }, bar(88, 28, 8)))
    }

    function DiscoverCard({ providers, autoScan, canSave, onEditor, onClose }) {
      const st = useStore(discStore)
      const { res, err, loading } = st
      const known = providers.map((p) => p.id).join(',')
      useEffect(() => {
        const s = discStore.get()
        if (s.loading) return
        // First time ever: scan once. Later mounts reuse it; providers changed ⇒ quiet refresh.
        if (!s.res && !s.err) { if (autoScan) runDiscover({ known, visible: true }) }
        else if (s.res && s.known !== known) runDiscover({ known, visible: false })
      }, [known])
      const run = () => runDiscover({ known, visible: true })
      const cands = res?.candidates ?? []
      const fresh = cands.filter((c) => !c.configuredAs).length
      // One-by-one reveal of a visible scan's tiles; computed in render so no frame shows them all.
      // `revealing` lasts a little past the last tile so that tile still gets its fade-in class.
      const [, tick] = useState(0)
      const since = Date.now() - discRevealAt.t
      const revealing = discRevealAt.gen === st.gen && since < (cands.length + 4) * REVEAL_MS
      const shown = revealing ? Math.min(cands.length, Math.floor(since / REVEAL_MS) + 1) : Infinity
      useEffect(() => {
        if (!revealing) return undefined
        const t = setInterval(() => tick((x) => x + 1), REVEAL_MS / 2)
        return () => clearInterval(t)
      }, [st.gen, revealing])
      const skel = loading && (st.visible || !res)
      const skelN = Math.min(Math.max(cands.length, 3), 10)
      const anim = revealing
      const shownTiles = skel ? [] : cands.slice(0, shown)
      const rest = skel ? 0 : cands.length - shownTiles.length
      const tile = (c) => {
        const on = !!c.configuredAs
        const p = on ? providers.find((x) => x.id === c.configuredAs) : undefined
        return h('div', { key: c.bin, className: `acp-tile${on ? ' on' : ''}${anim ? ' in' : ''}`, style: { '--pc': hueOf(c.bin) } },
          h('div', { className: 'acp-row', style: { gap: 9, flexWrap: 'nowrap' } },
            h('div', { className: 'acp-av sm' }, (c.displayName[0] ?? '?').toUpperCase()),
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('div', { className: 'nm' }, h('span', { title: c.displayName }, c.displayName), c.version ? h('small', null, `v${c.version}`) : null),
              h('div', { className: 'path', title: c.real !== c.path ? `${c.path} → ${c.real}` : c.path }, c.path)),
            null),
          h('div', { className: 'acp-chips' },
            on ? h(Chip, { kind: 'ok' }, `已接入 · ${c.configuredAs}`) : h(Chip, { kind: 'brand' }, '可添加'),
            h(Chip, { mono: true }, `${c.bin} ${(c.spec.command && c.spec.command !== c.path ? c.spec.args.slice(1) : c.spec.args).join(' ')}`.trim()),
            c.interpreter ? h(Chip, { title: c.spec.command && c.spec.command !== c.path ? `通过 ${c.spec.command} 启动 ${c.spec.args[0]}` : '添加时已自动补 env.PATH' }, `${c.interpreter} 脚本`) : h(Chip, null, '原生程序'),
            c.verified ? null : h(Chip, { kind: 'warn', title: '这个配方没在真机验证过，添加前先检测' }, '未验证')),
          c.note ? h('div', { className: 'note' }, c.note) : null,
          c.warning ? h('div', { className: 'note', style: { color: 'var(--acp-warn)' } }, c.warning) : null,
          h('div', { className: 'ft' },
            on
              ? h('button', { type: 'button', className: 'acp-btn', disabled: !canSave, onClick: () => onEditor({ mode: 'edit', id: c.configuredAs, spec: editSpecOf(p), title: p ? short(p.displayName) : c.displayName, efforts: p?.runtime?.efforts }) }, '编辑配置')
              : h('button', { type: 'button', className: 'acp-btn pri', disabled: !canSave, onClick: () => onEditor({ mode: 'add', id: c.id, spec: c.spec, recipeModelVia: c.recipeModelVia, title: c.displayName, note: c.note }) }, '配置并添加')))
      }
      return h('div', { className: 'acp-disc-wrap' },
        h('div', { className: 'acp-disc-hd' },
          h('div', { className: 'ic', 'aria-hidden': true },
            h('svg', { viewBox: '0 0 24 24', width: 17, height: 17, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('rect', { x: 3, y: 4, width: 18, height: 14, rx: 2.5 }), h('path', { d: 'M7 9l3 2.5L7 14' }), h('path', { d: 'M12.5 14H16' }))),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 't' }, '本机 ACP CLI'),
            h('div', { className: 's', 'aria-live': 'polite' }, skel
              ? h(Fragment, null, h('span', { className: 'acp-spin', 'aria-hidden': true }), '正在扫描：搜索 PATH 与常用安装目录，读取各 CLI 版本…')
              : res ? `找到 ${cands.length} 个 · ${fresh} 个可添加 · 搜索了 ${res.dirs.length} 个目录` : '找出已安装的 CLI，按推荐配置一键接入，不用手写 YAML')),
          onClose ? h('button', { type: 'button', className: 'acp-btn', onClick: onClose, title: '收起；之后点顶部「配置 CLI」再打开' }, '收起') : null,
          h('button', { type: 'button', className: 'acp-btn', disabled: !canSave, onClick: () => onEditor({ mode: 'add', id: '', spec: { command: '', args: [] } }) }, '+ 手动添加'),
          h('button', { type: 'button', className: 'acp-btn pri', disabled: loading, onClick: run, style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            loading ? h(Fragment, null, h('span', { className: 'acp-spin on-pri', 'aria-hidden': true }), '扫描中…') : res ? '重新扫描' : '扫描本机')),
        err ? h('div', { className: 'acp-probe fail', style: { marginTop: 10 } }, h('b', null, '扫描失败'), h('div', { className: 'msg' }, err)) : null,
        skel ? h('div', { className: 'acp-disc-grid', 'aria-busy': 'true', 'data-reveal': 'scanning' }, ...Array.from({ length: skelN }, (_, i) => h(SkelTile, { key: `s${i}`, i }))) : null,
        !skel && res && cands.length ? h('div', { className: 'acp-disc-grid', 'aria-busy': rest > 0 ? 'true' : 'false', 'data-reveal': rest > 0 ? 'running' : 'done' },
          ...shownTiles.map(tile), ...Array.from({ length: rest }, (_, i) => h(SkelTile, { key: `r${i}`, i: i + shownTiles.length }))) : null,
        !skel && res && !cands.length ? h('div', { className: 'acp-disc-empty' }, '没找到已知的 ACP CLI。装好后点「重新扫描」，或用「手动添加」接入其它 CLI。') : null,
        !canSave ? h('div', { className: 'acp-note', style: { color: 'var(--acp-warn)' } }, '当前 profile 不支持在界面里保存配置，只能扫描查看。') : null)
    }

    // ── provider card ──
    function ProviderCard({ p, color, usage, days, open, setOpen, busy, act, onEdit, onRemove }) {
      const [filter, setFilter] = useState('')
      const models = p.models ?? []
      const mName = (id) => models.find((m) => m.id === id)?.name ?? id
      const used = (id) => usage.byModel.find((m) => m.provider === p.id && m.model === id)
      const shown = models.filter((m) => !filter || `${m.id} ${m.name}`.toLowerCase().includes(filter.toLowerCase()))
      const off = models.filter((m) => m.disabled).length
      const setModels = (ids, disabled) => act(`m:${p.id}`, () => post(R.models, { provider: p.id, models: ids, disabled }))
      const pu = usage.byProvider.find((x) => x.provider === p.id)
      const rt = p.runtime ?? {}
      const last = rt.lastTurn
      const inflight = rt.inflight ?? []
      const [sk, sl] = STATUS[p.enabled ? p.status : 'off'] ?? ['', p.status]
      const name = short(p.displayName)
      const maxTok = Math.max(1, ...models.map((m) => tokOf(used(m.id))))
      const cmd = [p.command, ...(p.args ?? [])].join(' ')
      return h('div', { className: `acp-prov${open ? ' open' : ''}${p.enabled ? '' : ' off'}`, style: { '--pc': color } },
        h('div', { className: 'acp-row', style: { flexWrap: 'nowrap' } },
          h('div', { className: 'acp-av' }, (name[0] ?? '?').toUpperCase()),
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { className: 'acp-pname', title: p.displayName }, name),
            h('div', { className: 'acp-chips' },
              h(Chip, { kind: sk, title: p.statusText }, sl),
              h(Chip, { mono: true }, p.id),
              p.cli?.version ? h(Chip, null, `v${p.cli.version}`) : null,
              h(Chip, { title: `permission: ${p.permission}` }, PERM[p.permission] ?? p.permission),
              inflight.length ? h(Chip, { kind: 'warn' }, `进行中 ${inflight.length}`) : null)),
          h(Switch, { checked: p.enabled, disabled: busy !== '', label: `${p.enabled ? '停用' : '启用'} ${name}`, onChange: (v) => act(`p:${p.id}`, () => post(R.provider, { provider: p.id, enabled: v })) })),
        p.status === 'fail' || p.status === 'warn' ? h('div', { className: 'acp-note', style: { color: p.status === 'fail' ? 'var(--acp-err)' : 'var(--acp-warn)' } }, p.statusText) : null,
        h('div', { className: 'acp-mini' },
          h('div', null, h('div', { className: 'l' }, '轮次'), h('div', { className: 'v' }, n0(pu?.turns))),
          h('div', null, h('div', { className: 'l' }, 'Token'), h('div', { className: 'v' }, compact(tokOf(pu)))),
          h('div', null, h('div', { className: 'l' }, '成功率'), h('div', { className: 'v' }, pct(num(pu?.ok), num(pu?.turns)))),
          h('div', null, h('div', { className: 'l' }, '平均耗时'), h('div', { className: 'v' }, pu?.turns ? dur(pu.ms / pu.turns) : '-'))),
        days.length > 1 ? h(Spark, { values: days.map((d) => num(d.providers?.[p.id])), color }) : null,
        h('div', { className: 'acp-meterline' }, h('span', null, '可用模型'), h('span', null, p.models ? `${models.length - off} / ${models.length}${off ? ` · 停用 ${off}` : ''}` : '读取中…')),
        h('div', { className: 'acp-meter' }, h('i', { style: { width: `${models.length ? ((models.length - off) / models.length) * 100 : 0}%` } })),
        h('div', { className: 'acp-pool' },
          h('div', { className: 'acp-pool-hd' }, h('span', null, '会话池'), h('span', null, `暖 ${num(rt.warmSessions)} / ${num(p.maxSessions)} · 进程 ${num(rt.liveChildren)}`)),
          h('div', { className: 'acp-pool-segs' }, ...Array.from({ length: Math.max(1, num(p.maxSessions)) }, (_, i) => h('i', { key: i, className: i < num(rt.warmSessions) ? 'warm' : i < num(rt.warmSessions) + num(rt.liveChildren) ? 'live' : '' }))),
          h('div', { className: 'acp-note', style: { marginTop: 4 } }, `${p.reuseSessions ? '复用暖会话' : '每轮新进程'} · 空闲 ${dur(p.idleTimeoutMs)} 回收${p.resumeSessions ? ' · 支持恢复' : ''}`)),
        h('div', { className: 'acp-info' },
          h('span', null, '进程 ', h('b', null, num(rt.liveChildren)), ' · 暖会话 ', h('b', null, `${num(rt.warmSessions)}/${p.maxSessions}`)),
          h('span', null, '模型发现 ', h('b', null, rt.discovery ? `${rt.discovery.ok ? '成功' : '失败'} ${dur(rt.discovery.ms)}` : '未执行'), rt.discovery ? ` · ${ago(rt.discovery.at)}` : ''),
          rt.catalogCache ? h('span', { title: rt.catalogCache.disk ? '重启后先用磁盘上的上次结果，过期后在后台刷新' : '内存中的发现结果，过期后先用旧列表、后台刷新' }, '模型列表 ', h('b', null, `${rt.catalogCache.count} 个`), ` · ${rt.catalogCache.disk ? '磁盘缓存' : '缓存'}于 ${ago(rt.catalogCache.at)}`) : null,
          h('span', null, '图片 ', h('b', null, rt.images === true ? '支持' : rt.images === false ? '不支持' : '未知')),
          h('span', { title: last?.message }, '最近一轮 ', last ? h(ResultChip, { r: last }) : h('b', null, '无'), last ? ` ${mName(last.model)} · ${dur(last.ms)} · ${ago(last.at)}` : '')),
        h('details', { className: 'acp-det' },
          h('summary', null, '配置详情'),
          h('dl', { className: 'acp-dl' },
            h('dt', null, '命令'), h('dd', { className: 'acp-mono' }, cmd),
            h('dt', null, '权限'), h('dd', null, `${p.permission}（${PERM[p.permission] ?? ''}）`),
            h('dt', null, '选模型'), h('dd', null, p.modelVia === 'configOption' ? 'ACP 配置项（会话内切换）' : '命令行 --model'),
            h('dt', null, '超时'), h('dd', null, `单轮 ${dur(p.promptTimeoutMs)} · 无输出 ${dur(p.idleTimeoutMs)} · 启动 ${dur(p.startupTimeoutMs)}`),
            h('dt', null, '会话'), h('dd', null, `${p.reuseSessions ? '复用暖会话' : '每轮新进程'} · ${p.resumeSessions ? '支持恢复' : '不恢复'}`))),
        h('div', { className: 'acp-tools' },
          h('button', { type: 'button', className: `acp-btn${open ? ' on' : ''}`, onClick: () => setOpen(!open) }, open ? '收起模型' : `管理模型${p.models ? ` · ${models.length}` : ''}`),
          h('button', { type: 'button', className: 'acp-btn', disabled: busy !== '', onClick: () => act(`r:${p.id}`, () => post(R.refresh, { provider: p.id })) }, busy === `r:${p.id}` ? '读取中…' : '重新读取模型'),
          onEdit ? h('button', { type: 'button', className: 'acp-btn', onClick: onEdit }, '编辑配置') : null,
          onRemove ? h('button', { type: 'button', className: 'acp-btn danger', disabled: busy !== '', title: '从插件配置里删除这个渠道（停用只是暂时关掉，删除后卡片和模型列表里都不再出现）', onClick: onRemove }, busy === `x:${p.id}` ? '删除中…' : '删除') : null),
        open ? h('div', { style: { marginTop: 10 } },
          h('div', { className: 'acp-tools', style: { marginTop: 0, marginBottom: 8 } },
            h('input', { className: 'acp-input', type: 'search', placeholder: '搜索模型名或 ID…', value: filter, onChange: (e) => setFilter(e.target.value) }),
            h('button', { type: 'button', className: 'acp-btn', disabled: busy !== '' || off === 0, onClick: () => setModels(models.map((m) => m.id), false) }, '全部启用'),
            h('button', { type: 'button', className: 'acp-btn', disabled: busy !== '' || !models.length, onClick: () => setModels(models.filter((m) => m.id !== 'default').map((m) => m.id), true) }, '全部停用（保留默认）'),
            h('button', { type: 'button', className: 'acp-btn', disabled: busy !== '' || !models.some((m) => rateNum(m.rate) >= 1), onClick: () => setModels(models.filter((m) => rateNum(m.rate) >= 1).map((m) => m.id), true) }, '停用 ≥1x 高倍率')),
          h('div', { className: 'acp-scroll' }, h('table', { className: 'acp-table' },
            h('thead', null, h('tr', null, ...['启用', '名称', '写法', '倍率', '轮次', 'Token', '最近使用'].map((t, i) => h('th', { key: t, className: i === 4 || i === 5 ? 'num' : undefined }, t)))),
            h('tbody', null, ...shown.map((m) => {
              const u = used(m.id)
              return h('tr', { key: m.id, className: m.disabled ? 'dis' : undefined },
                h('td', null, h(Switch, { checked: !m.disabled, disabled: busy !== '', label: `${m.disabled ? '启用' : '停用'} ${m.name}`, onChange: (v) => setModels([m.id], !v) })),
                h('td', { className: 'name' }, m.name),
                h('td', { className: 'acp-mono' }, `${p.id}/${m.id}`),
                h('td', null, h(Rate, { rate: m.rate })),
                h('td', { className: 'num' }, u ? n0(u.turns) : '-'),
                h('td', { className: 'num' }, u ? h('span', { className: 'acp-cb' }, h('span', { style: { width: `${Math.max(4, (tokOf(u) / maxTok) * 60)}px` } }), compact(tokOf(u))) : '-'),
                h('td', null, u ? ago(u.lastAt) : '-'))
            })))),
          (p.staleDisabled ?? []).length ? h('div', { className: 'acp-note' }, '已停用但 CLI 已不再提供：', ...p.staleDisabled.map((id) => h('button', { key: id, type: 'button', className: 'acp-btn', style: { marginLeft: 6 }, disabled: busy !== '', onClick: () => setModels([id], false) }, `恢复 ${id}`))) : null,
          h('div', { className: 'acp-note' }, '停用的模型不出现在模型选择器里；仍被引用时这一轮会报 ACP_MODEL_DISABLED。开关立即生效，不需要重启。')) : null)
    }

    // ── per-session statistics (in-progress row → inline detail) ──
    /** Stable key for one in-flight turn across 15s refreshes (startedAt persists until it ends). */
    const flightKey = (f) => `${f.provider}/${f.session ?? ''}/${f.startedAt}`
    /** Finished turns belonging to one host session, oldest→newest. No session id → no history. */
    const sessionRecords = (recent, session) => session
      ? (recent ?? []).filter((r) => r.session === session).slice().sort((a, b) => num(a.at) - num(b.at))
      : []
    function summarizeSession(rows) {
      const s = { turns: 0, ok: 0, failed: 0, aborted: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, ms: 0, estimated: 0, firstAt: 0, lastAt: 0 }
      for (const r of rows) {
        s.turns++
        if (r.ok) s.ok++
        else if (r.aborted === true || r.code === 'DISPOSED') s.aborted++
        else s.failed++
        s.inputTokens += num(r.inputTokens)
        s.outputTokens += num(r.outputTokens)
        s.cacheReadTokens += num(r.cacheReadTokens)
        s.ms += num(r.ms)
        if (r.estimated) s.estimated++
        if (!s.firstAt || num(r.at) < s.firstAt) s.firstAt = num(r.at)
        s.lastAt = Math.max(s.lastAt, num(r.at))
      }
      return s
    }
    function sessionModels(rows) {
      const m = {}
      for (const r of rows) {
        const k = `${r.provider}/${r.model ?? 'default'}`
        const e = m[k] ?? (m[k] = { provider: r.provider, model: r.model ?? 'default', turns: 0, inputTokens: 0, outputTokens: 0 })
        e.turns++
        e.inputTokens += num(r.inputTokens)
        e.outputTokens += num(r.outputTokens)
      }
      return Object.values(m).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
    }
    /** Statistics scoped to a single in-progress session: identity of the live turn plus the
     *  finished-turn totals, per-turn token trend, model split and turn list. All derived from the
     *  dashboard payload's recent log, so it hot-applies without a host restart. */
    function SessionStats({ f, recent, colorOf, nameOf, rangeLabel, provider, modelOf = rawModelOf, sessInfo, onFilterSession }) {
      const rows = sessionRecords(recent, f.session)
      const s = summarizeSession(rows)
      const models = sessionModels(rows)
      const tokens = s.inputTokens + s.outputTokens
      const success = pctN(s.ok, s.turns)
      const col = colorOf(f.provider)
      const tv = timeoutView(f, provider)
      const done = f.done === true
      const info = sessInfo?.(f.session, f.cwd) ?? null
      const kv = (l, v) => h('div', { key: l }, h('div', { className: 'l' }, l), h('div', { className: 'v' }, v))
      return h('div', { className: 'acp-sd' },
        h('div', { className: 'acp-sd-hd' },
          h('span', { className: 'acp-sd-tag', title: info?.cwd }, h('i'), info ? `会话 ${info.project} · ${sess(f.session)}` : `会话 ${sess(f.session)}`),
          h(Prov, { color: col, name: f.name ?? nameOf(f.provider), model: modelOf(f.provider, f.model), title: `${f.provider}/${f.model}` }),
          h('span', { className: 'sp' }),
          done ? h(Chip, { title: '该会话最后一轮的活动时间' }, `最近活动 ${ago(s.lastAt || f.startedAt)}`)
            : h(Chip, { title: '已运行时长，随刷新更新' }, `已运行 ${dur(Date.now() - f.startedAt)}`),
          !done && tv.limit > 0 ? h(Chip, { kind: tv.over ? 'fail' : tv.near ? 'warn' : '', title: `单轮超时 ${dur(tv.limit)} · 已运行 ${dur(tv.elapsed)}` }, tv.over ? '已超时' : `剩余 ${dur(tv.remaining)}`) : null,
          onFilterSession && f.session ? h('button', { type: 'button', className: 'acp-btn', title: '让全页卡片只统计这个会话', onClick: () => onFilterSession(f.session) }, '只看此会话') : null),
        h('div', { className: 'acp-sd-info' },
          h('span', null, '开始 ', h('b', null, fmtTime(f.startedAt))),
          h('span', null, '提供方 ', h('b', null, f.name ?? nameOf(f.provider))),
          h('span', { title: f.session }, '会话 ID ', h('b', { className: 'acp-mono' }, f.session ? String(f.session).replace(/^session-/, '').slice(0, 12) : '-')),
          info ? h('span', { title: info.cwd }, '目录 ', h('b', null, info.project)) : null),
        rows.length ? h(Fragment, null,
          h('div', { className: 'acp-sd-k' },
            kv('已完成轮次', n0(s.turns)), kv('输入 Token', compact(s.inputTokens)), kv('输出 Token', compact(s.outputTokens)),
            kv('Token 合计', compact(tokens)), kv('成功率', `${success}%`), kv('平均耗时', s.turns ? dur(s.ms / s.turns) : '-')),
          (s.failed || s.aborted || s.estimated) ? h('div', { className: 'acp-note', style: { marginTop: -4 } },
            `其中失败 ${n0(s.failed)} · 中断 ${n0(s.aborted)}${s.estimated ? ` · ${n0(s.estimated)} 轮 Token 为估算*` : ''}`) : null,
          rows.length > 1 ? h(Fragment, null,
            h('div', { className: 'acp-sd-sub' }, `逐轮 Token 走势 · ${rows.length} 轮`),
            h(Spark, { values: rows.map((r) => num(r.inputTokens) + num(r.outputTokens)), color: col })) : null,
          models.length > 1 ? h(Fragment, null,
            h('div', { className: 'acp-sd-sub' }, '本会话使用的模型'),
            h('div', { className: 'acp-sd-mm' }, ...models.map((m) => h('span', { key: `${m.provider}/${m.model}` },
              h('b', { title: `${m.provider}/${m.model}` }, modelOf(m.provider, m.model)), ` · ${m.turns} 轮 · ${compact(m.inputTokens + m.outputTokens)} Token`)))) : null,
          h('div', { className: 'acp-sd-sub' }, '本会话已结束的轮次'),
          h('div', { className: 'acp-scroll' }, h('table', { className: 'acp-table' },
            h('thead', null, h('tr', null,
              ...['时间', '模型', '结果', '耗时', '输入', '输出'].map((x, i) => h('th', { key: x, className: i >= 3 ? 'num' : undefined }, x)))),
            h('tbody', null, ...rows.slice().reverse().map((r, i) => h('tr', { key: `${r.at}-${i}` },
              h('td', null, fmtTime(r.at)),
              h('td', { title: `${r.provider}/${r.model ?? 'default'}` }, modelOf(r.provider, r.model ?? 'default')),
              h('td', null, h(ResultChip, { r })),
              h('td', { className: 'num' }, dur(r.ms)),
              h('td', { className: 'num' }, `${compact(r.inputTokens)}${r.estimated ? '*' : ''}`),
              h('td', { className: 'num' }, `${compact(r.outputTokens)}${r.estimated ? '*' : ''}`)))))))
          : h(Empty, { text: done ? '该会话在最近日志窗口内没有轮次记录' : '该会话在所选范围内还没有已结束的轮次 · 当前这一轮结束后写入统计' }),
        h('div', { className: 'acp-sd-note' }, done
          ? '会话统计取自最近 100 条用量日志中该会话的已结束轮次；更早的轮次不在窗口内。'
          : `独立统计来自所选范围（${rangeLabel}）内已结束的轮次，取自最近 100 条用量日志；当前进行中的这一轮尚未计入，结束后自动写入。${f.session ? '' : ' 本轮没有会话标识，无法关联历史轮次。'}`))
    }

    // ── surface the payload's already-computed fields ───────────────────────
    /** Quantile of an ascending array. */
    const quantile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] : 0
    const modelKey = (r) => `${r.provider}/${r.model ?? 'default'}`
    const modelName = (k) => k.slice(k.indexOf('/') + 1) || k
    const providerOfKey = (k) => k.slice(0, k.indexOf('/'))

    /** Backend latency percentiles + per-turn detail (slowest turns, per-model P90) from recent. */
    function latencyView(usage) {
      const lat = usage?.latency ?? {}
      const rows = (usage?.recent ?? []).filter((r) => r.ok === true && num(r.ms) > 0)
      const ms = rows.map((r) => num(r.ms)).sort((a, b) => a - b)
      const slow = rows.slice().sort((a, b) => num(b.ms) - num(a.ms)).slice(0, 3)
      const groups = {}
      for (const r of rows) (groups[modelKey(r)] ?? (groups[modelKey(r)] = [])).push(num(r.ms))
      const tail = Object.entries(groups).map(([k, a]) => {
        a.sort((x, y) => x - y)
        return { key: k, model: modelName(k), provider: providerOfKey(k), p90: quantile(a, 0.9), turns: a.length }
      }).sort((a, b) => b.p90 - a.p90).slice(0, 4)
      return { p50: num(lat.p50), p90: num(lat.p90), max: num(lat.max), p99: quantile(ms, 0.99), slow, tail, sample: ms.length }
    }

    /** Cache: read totals are aggregated by the host; write tokens / chars use full-range
     *  totals once the host ships them, otherwise fall back to the recent log window. */
    function cacheView(usage) {
      const t = usage?.total ?? {}
      const read = num(t.cacheReadTokens)
      const input = num(t.inputTokens)
      const days = (usage?.byDay ?? []).map((d) => num(d.cacheReadTokens))
      const recent = usage?.recent ?? []
      const full = 'cacheWriteTokens' in t
      const write = full ? num(t.cacheWriteTokens) : recent.reduce((s, r) => s + num(r.cacheWriteTokens), 0)
      const chars = full ? num(t.chars) : recent.reduce((s, r) => s + num(r.chars), 0)
      const withWrite = recent.filter((r) => num(r.cacheWriteTokens) > 0).length
      const groups = {}
      for (const r of recent) {
        const k = modelKey(r)
        const e = groups[k] ?? (groups[k] = { key: k, model: r.model ?? 'default', provider: r.provider, input: 0, read: 0, turns: 0 })
        e.input += num(r.inputTokens); e.read += num(r.cacheReadTokens); e.turns++
      }
      const byModel = Object.values(groups).map((e) => ({ ...e, ratio: pctN(e.read, e.read + e.input) })).sort((a, b) => b.read - a.read || b.ratio - a.ratio).slice(0, 4)
      return { read, input, ratio: pctN(read, read + input), days, write, chars, full, withWrite, byModel, sample: recent.length }
    }

    /** Normalise providers[].quota (from lib/usage-probe.js) into rows for the quota card.
     *  Each row: { id, name, color, status, detail, source, probedAt, excerpt }. Never throws. */
    function quotaView(providers, colorOf = () => C_OTHER, nameOf = (x) => x) {
      const rows = (providers ?? []).map((p) => {
        const q = p?.quota ?? {}
        const base = { id: p.id, name: nameOf(p.id), color: colorOf(p.id), probedAt: num(q.probedAt), source: q.source || '' }
        if (q.pending) return { ...base, status: 'loading', detail: '正在后台探测…' }
        if (q.supported === false) return { ...base, status: 'unsupported', detail: q.note || '该 CLI 不提供非交互用量查询' }
        if (q.error) return { ...base, status: 'error', detail: q.error }
        const bits = []
        if (q.tier) bits.push(`套餐 ${q.tier}`)
        if (q.cost) bits.push(`花费 ${q.cost}`)
        if (q.sessions) bits.push(`${q.sessions} 会话`)
        if (q.tokens) {
          const t = q.tokens
          const tv = [t.input ? `入 ${t.input}` : '', t.output ? `出 ${t.output}` : '', t.cacheRead ? `缓存读 ${t.cacheRead}` : ''].filter(Boolean).join(' / ')
          if (tv) bits.push(tv)
        }
        if (q.identity) bits.push(q.identity)
        const detail = bits.length ? bits.join(' · ') : (q.note || '')
        return { ...base, status: detail ? 'ok' : 'empty', detail, excerpt: q.excerpt || '' }
      })
      const ok = rows.filter((r) => r.status === 'ok').length
      return { rows, ok, total: rows.length }
    }

    /** Errors: enrich backend buckets with a first-seen time from recent + daily failure rate. */
    function errorView(usage) {
      const recent = usage?.recent ?? []
      const codes = (usage?.errors ?? []).map((e) => {
        const times = recent.filter((r) => r.code === e.code).map((r) => num(r.at)).filter((v) => v > 0)
        return { ...e, firstAt: times.length ? Math.min(...times) : 0 }
      })
      const byDay = (usage?.byDay ?? []).map((d) => ({ date: d.date, rate: pctN(num(d.failed), num(d.turns)) }))
      // Group raw codes into friendly classes (限流 / 额度 / 认证 …) for the insights view.
      const grouped = new Map()
      for (const e of codes) {
        const cls = errorClass(e.code)
        let g = grouped.get(cls.key)
        if (!g) { g = { key: cls.key, label: cls.label, color: cls.color, count: 0, codes: [] }; grouped.set(cls.key, g) }
        g.count += num(e.count)
        g.codes.push(e.code)
      }
      const classes = [...grouped.values()].sort((a, b) => b.count - a.count)
      return { codes, byDay, classes, total: codes.reduce((s, e) => s + num(e.count), 0), sample: recent.length }
    }

    /** Relative credit consumption = model rate multiplier × tokens. Not a currency amount. */
    function creditView(providers, byModel) {
      const rates = {}
      for (const p of providers ?? []) for (const m of p.models ?? []) rates[`${p.id}/${m.id}`] = m.rate
      const rows = (byModel ?? []).map((m) => {
        const key = `${m.provider}/${m.model}`
        const rate = rates[key]
        return { key, model: m.model, provider: m.provider, rate, mul: rateMul(rate), known: rate !== undefined, tokens: tokOf(m), credit: tokOf(m) * rateMul(rate) }
      }).sort((a, b) => b.credit - a.credit)
      return { rows, total: rows.reduce((s, r) => s + r.credit, 0), unknown: rows.filter((r) => !r.known).length }
    }

    /** Throughput: output tokens per second of turn time, chars↔Token ratio. Full-range
     *  backend totals when present, otherwise the recent log window. */
    function throughputView(usage) {
      const t = usage?.total ?? {}
      const recent = usage?.recent ?? []
      const full = 'chars' in t
      const chars = full ? num(t.chars) : recent.reduce((s, r) => s + num(r.chars), 0)
      const out = full ? num(t.outputTokens) : recent.reduce((s, r) => s + num(r.outputTokens), 0)
      const input = full ? num(t.inputTokens) : recent.reduce((s, r) => s + num(r.inputTokens), 0)
      const ms = full ? num(t.ms) : recent.reduce((s, r) => s + num(r.ms), 0)
      const groups = {}
      for (const r of full ? (usage?.byModel ?? []) : recent) {
        const k = modelKey(r)
        const e = groups[k] ?? (groups[k] = { key: k, model: r.model ?? 'default', provider: r.provider, out: 0, ms: 0, turns: 0 })
        e.out += num(r.outputTokens); e.ms += num(r.ms); e.turns += full ? num(r.turns) : 1
      }
      const byModel = Object.values(groups).map((e) => ({ ...e, tps: e.ms > 0 ? e.out / (e.ms / 1000) : 0 })).filter((e) => e.tps > 0).sort((a, b) => b.tps - a.tps).slice(0, 4)
      return { tps: ms > 0 ? out / (ms / 1000) : 0, ratio: input > 0 ? chars / input : 0, chars, out, ms, full, byModel, sample: recent.length }
    }

    /** Data quality: estimated-turn share + which models never report real usage. */
    function qualityView(usage) {
      const t = usage?.total ?? {}
      const groups = {}
      for (const r of usage?.recent ?? []) {
        if (!r.estimated) continue
        const k = modelKey(r)
        groups[k] = (groups[k] ?? 0) + 1
      }
      const byModel = Object.entries(groups).map(([k, n]) => ({ key: k, model: modelName(k), turns: n })).sort((a, b) => b.turns - a.turns).slice(0, 4)
      return { estimated: num(t.estimated), turns: num(t.turns), ratio: pctN(num(t.estimated), num(t.turns)), byModel }
    }

    /** Elapsed vs a provider's single-turn prompt timeout. */
    function timeoutView(f, p) {
      const limit = num(p?.promptTimeoutMs)
      const elapsed = Math.max(0, Date.now() - num(f?.startedAt))
      const ratio = limit > 0 ? elapsed / limit : 0
      return { limit, elapsed, ratio: Math.min(1, ratio), near: limit > 0 && ratio >= 0.8 && ratio < 1, over: limit > 0 && ratio >= 1, remaining: limit > 0 ? Math.max(0, limit - elapsed) : 0 }
    }

    /** One-click report: copyable Markdown summary of the current view (range, compare, top
     *  models, anomalies, slowest requests, data quality). */
    function weeklyReport({ usage, prev, rangeLabel, modelOf = rawModelOf, nameOf = (x) => x, filter, providers }) {
      const t = usage?.total ?? {}
      const tokens = num(t.inputTokens) + num(t.outputTokens)
      const L = [`# ACP 用量报告 · ${rangeLabel}`]
      const fkeys = Object.keys(filter ?? {})
      if (fkeys.length) L.push(`> 筛选：${[filter.provider, filter.model, filter.session].filter(Boolean).join(' / ')}`)
      L.push('', '## 总览',
        `- 轮次：**${n0(t.turns)}**（成功 ${n0(t.ok)} · 失败 ${n0(t.failed)} · 中断 ${n0(t.aborted)} · 成功率 ${pct(t.ok, t.turns)}）`,
        `- Token：输入 ${compact(t.inputTokens)} / 输出 ${compact(t.outputTokens)}，合计 ${compact(tokens)}${num(t.cacheReadTokens) ? `（缓存读 ${compact(t.cacheReadTokens)}）` : ''}`,
        `- 平均耗时 ${num(t.turns) ? dur(num(t.ms) / num(t.turns)) : '-'} · P50 ${dur(usage?.latency?.p50)} · P90 ${dur(usage?.latency?.p90)}`)
      if (num(t.estimated)) L.push(`- 数据质量：${n0(t.estimated)} 轮未上报用量，Token 按字符 ÷ 4 估算（占 ${pct(t.estimated, t.turns)}）`)
      const pv = prev?.total
      if (pv && num(pv.turns) > 0) {
        const d = (c, o) => { const x = num(c), y = num(o); if (!y) return x ? '新增' : '持平'; const p = Math.round(((x - y) / y) * 100); return p > 0 ? `+${p}%` : `${p}%` }
        L.push('', '## 环比上期（等长周期）',
          `- 轮次 ${n0(pv.turns)} → ${n0(t.turns)}（${d(t.turns, pv.turns)}）`,
          `- Token ${compact(tokOf(pv))} → ${compact(tokens)}（${d(tokens, tokOf(pv))}）`,
          `- 成功率 ${pct(pv.ok, pv.turns)} → ${pct(t.ok, t.turns)}`,
          `- 平均耗时 ${num(pv.turns) ? dur(num(pv.ms) / num(pv.turns)) : '-'} → ${num(t.turns) ? dur(num(t.ms) / num(t.turns)) : '-'}`)
      }
      const bm = (usage?.byModel ?? []).slice().sort((a, b) => tokOf(b) - tokOf(a)).slice(0, 5)
      if (bm.length) {
        L.push('', '## Top 模型', '| 模型 | 轮次 | 成功率 | Token |', '| --- | ---: | ---: | ---: |')
        for (const m of bm) L.push(`| ${nameOf(m.provider)} / ${modelOf(m.provider, m.model)} | ${n0(m.turns)} | ${pct(m.ok, m.turns)} | ${compact(tokOf(m))} |`)
      }
      const sd = sessionDistView(usage, { metric: 'tokens', group: 'model', nameOf, modelOf })
      if (sd.sessions.length) {
        L.push('', `## 会话 × 模型（${n0(sd.sessionCount)} 个会话 · ${n0(sd.multi)} 个跨模型）`, '| 会话 | 模型分布（按 Token 占比） | Token |', '| --- | --- | ---: |')
        for (const s of sd.sessions.slice(0, 5)) L.push(`| ${s.session ? String(s.session).replace(/^session-/, '').slice(0, 8) : '（无标识）'} | ${s.slices.map((sl) => `${modelOf(sl.provider, sl.model)} ${pct(sl.tokens, s.tokens)}`).join('、')} | ${compact(s.tokens)} |`)
      }
      const errs = usage?.errors ?? []
      if (errs.length) {
        L.push('', '## 异常')
        const ec = errorView(usage)
        if (ec.classes.length) L.push(`- 错误类别：${ec.classes.map((c) => `${c.label} ${n0(c.count)}（${pct(c.count, ec.total)}）`).join(' · ')}`)
        for (const e of errs.slice(0, 5)) L.push(`- \`${e.code}\` × ${n0(e.count)}（${nameOf(e.provider)} / ${modelOf(e.provider, e.model ?? 'default')}，最近 ${fmtTime(e.lastAt)}）：${String(e.message ?? '').slice(0, 120) || '无详情'}`)
      }
      const qv = quotaView(providers, () => '', nameOf)
      const qrows = qv.rows.filter((r) => r.status === 'ok' || r.status === 'error')
      if (qrows.length) {
        L.push('', '## CLI 用量/额度探测（非账户余额）')
        for (const r of qrows) L.push(`- ${r.name}：${r.detail}${r.source ? `（${r.source}）` : ''}`)
      }
      const slow = latencyView(usage).slow
      if (slow.length) {
        L.push('', `## 最慢请求（近 ${(usage?.recent ?? []).length} 轮窗口）`)
        for (const r of slow) L.push(`- ${fmtTime(r.at)} · ${nameOf(r.provider)} / ${modelOf(r.provider, r.model ?? 'default')} · ${dur(r.ms)}`)
      }
      L.push('', `> 生成于 ${fmtTime(Date.now())} · dsh-llm-acp`)
      return L.join('\n')
    }

    // ── chart export: standalone SVG / PNG ──
    function downloadBlob(blob, name) {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    }
    /** Resolve CSS variables / inherited styles into inline styles so the exported file renders
     *  identically outside the console. */
    function chartMarkup(svg) {
      const clone = svg.cloneNode(true)
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      const live = [svg, ...svg.querySelectorAll('*')]
      const copy = [clone, ...clone.querySelectorAll('*')]
      for (let i = 0; i < live.length; i++) {
        const cs = getComputedStyle(live[i])
        const el = copy[i]
        el.removeAttribute('class')
        for (const p of ['fill', 'stroke', 'opacity', 'fillOpacity', 'strokeOpacity', 'fontFamily', 'fontSize', 'fontWeight']) el.style[p] = cs[p]
      }
      return new XMLSerializer().serializeToString(clone)
    }
    function exportChart(svg, kind, name) {
      if (!svg || typeof XMLSerializer === 'undefined' || typeof document === 'undefined') return
      const markup = chartMarkup(svg)
      if (kind === 'svg') { downloadBlob(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), `${name}.svg`); return }
      const img = new Image()
      img.onload = () => {
        const scale = 2
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, svg.width.baseVal.value) * scale
        canvas.height = Math.max(1, svg.height.baseVal.value) * scale
        const ctx = canvas.getContext('2d')
        ctx.scale(scale, scale)
        ctx.drawImage(img, 0, 0)
        canvas.toBlob((b) => { if (b) downloadBlob(b, `${name}.png`) }, 'image/png')
      }
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
    }

    /** Day drill-down: exact day payload when the host supports from/to, otherwise the turns
     *  of that day inside the recent log window. */
    function dayDrill(date, payload, recent) {
      const exact = payload?.from !== undefined
      const u = exact ? payload.usage : null
      const rows = exact ? (u?.recent ?? []) : (recent ?? []).filter((r) => dateStr(num(r.at)) === date)
      const hours = exact ? (u?.hours ?? Array.from({ length: 24 }, () => 0))
        : Array.from({ length: 24 }, (_, i) => rows.filter((r) => new Date(num(r.at)).getHours() === i).length)
      const total = exact ? (u?.total ?? {}) : rows.reduce((a, r) => ({
        turns: a.turns + 1, ok: a.ok + (r.ok ? 1 : 0),
        failed: a.failed + (!r.ok && !(r.aborted || r.code === 'DISPOSED') ? 1 : 0),
        inputTokens: a.inputTokens + num(r.inputTokens), outputTokens: a.outputTokens + num(r.outputTokens),
      }), { turns: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0 })
      const sess = {}
      for (const r of rows) {
        const k = r.session ?? ''
        const e = sess[k] ?? (sess[k] = { session: k, turns: 0, tokens: 0, provider: r.provider, cwd: r.cwd, lastAt: 0 })
        e.turns++; e.tokens += num(r.inputTokens) + num(r.outputTokens); e.lastAt = Math.max(e.lastAt, num(r.at))
        if (r.cwd) e.cwd = r.cwd
      }
      const sessions = Object.values(sess).sort((a, b) => b.tokens - a.tokens)
      return { exact, hours, total, rows, sessions }
    }

    /** Session × model distribution: per-session slices ranked by the chosen metric, plus a
     *  global key ranking (top 6 + 其他) shared by the legend, bars and matrix columns. Uses the
     *  host's bySession buckets (full range); falls back to the recent log window on old hosts. */
    function sessionDistView(usage, { metric = 'tokens', group = 'model', colorOf = () => C_OTHER, nameOf = (x) => x, modelOf = rawModelOf } = {}) {
      const full = Array.isArray(usage?.bySession)
      const val = (s) => (metric === 'turns' ? num(s.turns) : num(s.tokens))
      let sessions
      if (full) {
        sessions = usage.bySession.map((s) => ({
          session: s.session ?? '', cwd: s.cwd ?? '', turns: num(s.turns), tokens: tokOf(s), lastAt: num(s.lastAt),
          slices: Object.entries(s.models ?? {}).map(([k, v]) => ({ key: k, provider: providerOfKey(k), model: modelName(k), turns: num(v?.turns), tokens: num(v?.inputTokens) + num(v?.outputTokens) })),
        }))
      } else {
        const groups = new Map()
        for (const r of usage?.recent ?? []) {
          const k = r.session ?? ''
          if (!groups.has(k)) groups.set(k, [])
          groups.get(k).push(r)
        }
        sessions = [...groups.entries()].map(([k, rows]) => {
          const s = summarizeSession(rows)
          return {
            session: k, cwd: rows.find((r) => r.cwd)?.cwd ?? '', turns: s.turns, tokens: s.inputTokens + s.outputTokens, lastAt: s.lastAt,
            slices: sessionModels(rows).map((m) => ({ key: `${m.provider}/${m.model}`, provider: m.provider, model: m.model, turns: m.turns, tokens: m.inputTokens + m.outputTokens })),
          }
        })
      }
      if (group === 'provider') {
        for (const s of sessions) {
          const m = new Map()
          for (const sl of s.slices) {
            const e = m.get(sl.provider) ?? { key: sl.provider, provider: sl.provider, model: '', turns: 0, tokens: 0 }
            e.turns += sl.turns; e.tokens += sl.tokens
            m.set(sl.provider, e)
          }
          s.slices = [...m.values()]
        }
      }
      for (const s of sessions) {
        s.slices = s.slices.filter((sl) => val(sl) > 0).sort((a, b) => val(b) - val(a))
        s.value = s.slices.reduce((sum, sl) => sum + val(sl), 0)
      }
      sessions = sessions.filter((s) => s.value > 0).sort((a, b) => b.value - a.value || b.turns - a.turns)
      const totals = new Map()
      for (const s of sessions) for (const sl of s.slices) {
        const e = totals.get(sl.key) ?? { key: sl.key, provider: sl.provider, model: sl.model, value: 0, turns: 0 }
        e.value += val(sl); e.turns += sl.turns
        totals.set(sl.key, e)
      }
      const ranked = [...totals.values()].sort((a, b) => b.value - a.value)
      const rest = ranked.slice(6)
      const keys = ranked.slice(0, 6).map((e, i) => ({ ...e, label: group === 'provider' ? nameOf(e.provider) : modelOf(e.provider, e.model), color: group === 'provider' ? colorOf(e.provider) : PALETTE[i % PALETTE.length] }))
      // Same display name offered by two providers → append the provider so they stay distinguishable.
      const labelCount = {}
      for (const k of keys) labelCount[k.label] = (labelCount[k.label] ?? 0) + 1
      for (const k of keys) if (labelCount[k.label] > 1) k.label = `${k.label} · ${nameOf(k.provider)}`
      if (rest.length) keys.push({ key: '__other__', provider: '', model: '', label: `其他 ${rest.length}`, value: rest.reduce((s, e) => s + e.value, 0), turns: rest.reduce((s, e) => s + e.turns, 0), color: C_OTHER, rest: rest.map((e) => e.key) })
      for (const s of sessions) {
        s.byKey = {}
        for (const sl of s.slices) s.byKey[sl.key] = (s.byKey[sl.key] ?? 0) + val(sl)
        if (rest.length) s.byKey.__other__ = rest.reduce((sum, e) => sum + num(s.byKey[e.key]), 0)
      }
      return {
        full, metric, group, sessions, keys,
        multi: sessions.filter((s) => s.slices.length > 1).length,
        sessionCount: full ? Math.max(num(usage.sessionCount), sessions.length) : sessions.length,
        totalValue: sessions.reduce((s, x) => s + x.value, 0),
      }
    }

    const SD_METRICS = [['tokens', 'Token'], ['turns', '轮次']]
    const SD_GROUPS = [['model', '按模型'], ['provider', '按提供方']]
    const SD_VIEWS = [['bars', '条形图'], ['matrix', '矩阵表']]
    /** Which sessions used which models: stacked per-session bars or a session × model matrix.
     *  Clicking a segment / cell cross-filters the whole page by session + model (or provider). */
    function SessionDistCard({ usage, colorOf, nameOf, modelOf = rawModelOf, sessText = (id) => sess(id), sessTitle = () => undefined, metric: metricProp, group: groupProp, view: viewProp, onMetric, onGroup, onView, filter, onPickCell, onPickSession, onPickKey, card }) {
      const [metricLocal, setMetricLocal] = useState('tokens')
      const [groupLocal, setGroupLocal] = useState('model')
      const [viewLocal, setViewLocal] = useState('bars')
      const metric = metricProp ?? metricLocal
      const group = groupProp ?? groupLocal
      const view = viewProp ?? viewLocal
      const setMetric = onMetric ?? setMetricLocal
      const setGroup = onGroup ?? setGroupLocal
      const setView = onView ?? setViewLocal
      const plotRef = useRef(null)
      const [W, setW] = useState(560)
      useEffect(() => {
        const el = plotRef.current
        if (!el) return undefined
        const measure = () => { const w = Math.round(el.getBoundingClientRect().width); if (w > 0) setW(w) }
        measure()
        if (typeof ResizeObserver !== 'undefined') {
          const ro = new ResizeObserver(measure)
          ro.observe(el)
          return () => ro.disconnect()
        }
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [])
      const dv = sessionDistView(usage, { metric, group, colorOf, nameOf, modelOf })
      const shown = dv.sessions.slice(0, 10)
      const unit = metric === 'turns' ? '轮' : 'Token'
      const fmt = (v) => (metric === 'turns' ? n0(v) : compact(v))
      const seg = (opts, cur, set, label) => h('div', { className: 'acp-seg', role: 'tablist', 'aria-label': label }, ...opts.map(([v, text]) => h('button', { key: v, type: 'button', role: 'tab', 'aria-selected': String(cur === v), className: cur === v ? 'on' : '', onClick: () => set(v) }, text)))
      const cellPick = (s, k) => {
        if (k === '__other__') { onPickSession?.(s.session); return }
        onPickCell?.(s.session, k, group)
      }
      const activeCell = (s, k) => {
        if (!filter?.session || filter.session !== s.session) return false
        if (k === '__other__') return !filter.provider
        return group === 'provider' ? filter.provider === k && !filter.model : filter.provider === providerOfKey(k) && filter.model === modelName(k)
      }
      const doExport = (kind) => exportChart(plotRef.current?.querySelector('svg'), kind, `acp-sessions-${dateStr(Date.now())}`)
      const maxCell = Math.max(1, ...shown.flatMap((s) => dv.keys.map((k) => num(s.byKey[k.key]))))

      const PL = 150, PR = 66, rowH = 30
      const barW = Math.max(40, W - PL - PR)
      const H = shown.length * rowH + 6
      const bars = h('div', { className: 'acp-plot', ref: plotRef },
        h('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': '会话模型分布条形图', style: { display: 'block', maxWidth: '100%', height: 'auto' } },
          ...shown.flatMap((s, i) => {
            const y = i * rowH + 5
            const label = sessText(s.session, s.cwd)
            const out = [
              h('text', { key: `l${i}`, x: 0, y: y + 12, fontSize: 11, fill: 'var(--acp-fg)', className: 'acp-sdlab', onClick: onPickSession && s.session ? () => onPickSession(s.session) : undefined },
                label.length > 20 ? `${label.slice(0, 19)}…` : label,
                h('title', null, `${sessTitle(s.session, s.cwd) ?? label} · 点击只看此会话`)),
              h('rect', { key: `t${i}`, x: PL, y, width: barW, height: 16, rx: 3, style: { fill: 'var(--acp-sub)' } }),
              h('text', { key: `v${i}`, x: W - 4, y: y + 12, textAnchor: 'end', fontSize: 10.5, style: { fill: 'var(--acp-muted)' } }, fmt(s.value)),
            ]
            let acc = 0
            for (const k of dv.keys) {
              const v = num(s.byKey[k.key])
              if (v <= 0) continue
              const w = (v / s.value) * barW
              out.push(h('rect', {
                key: `s${i}-${k.key}`, x: PL + acc, y, width: Math.max(0.6, w - 1), height: 16, rx: 2,
                className: 'acp-sdseg', style: { fill: k.color, stroke: activeCell(s, k.key) ? 'var(--acp-fg)' : 'none' }, strokeWidth: 1.4,
                onClick: () => cellPick(s, k.key),
              }, h('title', null, `${label} · ${k.label}：${fmt(v)} ${unit}（${pct(v, s.value)}）· 点击筛选`)))
              acc += w
            }
            return out
          })))

      const matrix = h('div', { className: 'acp-scroll' }, h('table', { className: 'acp-table acp-mx' },
        h('thead', null, h('tr', null,
          h('th', { key: 'sess' }, '会话'),
          ...dv.keys.map((k) => h('th', { key: k.key, className: 'num', title: k.key === '__other__' ? '其余模型合计' : group === 'provider' ? k.provider : `${k.provider}/${k.model}` }, h('i', { className: 'dot', style: { background: k.color } }), k.label)),
          h('th', { key: 'sum', className: 'num' }, '合计'))),
        h('tbody', null, ...shown.map((s) => h('tr', { key: s.session || 'none' },
          h('td', null, s.session
            ? h('button', { type: 'button', className: 'acp-link', title: sessTitle(s.session, s.cwd), onClick: () => onPickSession?.(s.session) }, sessText(s.session, s.cwd))
            : sessText(s.session, s.cwd)),
          ...dv.keys.map((k) => {
            const v = num(s.byKey[k.key])
            return h('td', {
              key: k.key, className: `num cell${activeCell(s, k.key) ? ' sel' : ''}`,
              style: v > 0 ? { background: `color-mix(in srgb, ${k.color} ${Math.round(8 + (v / maxCell) * 55)}%, transparent)` } : undefined,
              title: v > 0 ? `${sessText(s.session, s.cwd)} · ${k.label}：${fmt(v)} ${unit} · 点击筛选全页` : undefined,
              onClick: v > 0 ? () => cellPick(s, k.key) : undefined,
            }, v > 0 ? fmt(v) : '·')
          }),
          h('td', { key: 'sum', className: 'num' }, h('b', null, fmt(s.value))))))))

      return h(Card, { className: 's12', title: '会话 × 模型分布', sub: '哪个会话用了哪些模型 · 点击筛选全页', ...card },
        h('div', { className: 'acp-tt' },
          h('span', { className: 'acp-tt-l' }, '指标'), seg(SD_METRICS, metric, setMetric, '分布指标'),
          h('span', { className: 'acp-tt-l' }, '分组'), seg(SD_GROUPS, group, setGroup, '分布分组'),
          h('span', { className: 'acp-sp' }),
          seg(SD_VIEWS, view, setView, '分布视图'),
          view === 'bars' ? h(Fragment, null,
            h('button', { type: 'button', className: 'acp-btn', title: '把当前图表存为 SVG 文件', onClick: () => doExport('svg') }, 'SVG'),
            h('button', { type: 'button', className: 'acp-btn', title: '把当前图表存为 PNG 图片（2 倍清晰度）', onClick: () => doExport('png') }, 'PNG')) : null),
        dv.sessions.length ? h(Fragment, null,
          view === 'bars' ? bars : matrix,
          h('div', { className: 'acp-legend wrap' }, ...dv.keys.map((k) => (k.key === '__other__'
            ? h('span', { key: k.key, className: 'acp-lg', style: { cursor: 'default' }, title: '其余模型合计' }, h('i', { style: { background: k.color } }), `${k.label} · ${fmt(k.value)}`)
            : h('button', { key: k.key, type: 'button', className: 'acp-lg', title: `${k.label} · 点击让全页只看这个${group === 'provider' ? '提供方' : '模型'}`, onClick: () => onPickKey?.(k.key, group) }, h('i', { style: { background: k.color } }), `${k.label} · ${fmt(k.value)}`)))),
          h('div', { className: 'acp-note' }, `${n0(dv.sessionCount)} 个会话 · ${n0(dv.multi)} 个用了多${group === 'provider' ? '提供方' : '模型'} · 合计 ${fmt(dv.totalValue)} ${unit}${dv.sessionCount > shown.length ? ` · 显示前 ${shown.length} 个` : ''}`),
          !dv.full ? h('div', { className: 'acp-note', style: { color: 'var(--acp-warn)' } }, '宿主未更新：会话分布仅统计最近 100 轮日志窗口内的记录，重启一次 DSH 后按完整范围统计。') : null)
          : h(Empty, { text: '所选范围内还没有会话用量' }))
    }

    /** Latency distribution card (s4). */
    function LatencyCard({ usage, colorOf, nameOf, modelOf = rawModelOf, card }) {
      const v = latencyView(usage)
      const base = Math.max(1, v.max, v.p90, v.p50)
      const kv = (l, val) => h('div', { key: l }, h('div', { className: 'l' }, l), h('div', { className: 'v' }, dur(val)))
      return h(Card, { className: 's4', title: '延迟分布', sub: '成功轮次', ...card },
        v.sample || v.max ? h(Fragment, null,
          h('div', { className: 'acp-lat-k' }, kv('P50', v.p50), kv('P90', v.p90), kv('最慢', v.max)),
          h('div', { className: 'acp-lat-track' },
            h('i', { style: { width: `${(v.p50 / base) * 100}%` } }),
            v.p90 > 0 ? h('u', { className: 'p90', style: { left: `${Math.min(99, (v.p90 / base) * 100)}%` } }) : null),
          h('div', { className: 'acp-ll' }, h('span', null, '0'), h('span', null, `P90 ${dur(v.p90)} · 最慢 ${dur(v.max)}`)),
          v.p99 > 0 ? h('div', { className: 'acp-note', style: { marginTop: 0, marginBottom: 4 } }, `近 ${v.sample} 轮 P99 ${dur(v.p99)}`) : null,
          v.slow.length ? h(Fragment, null,
            h('div', { className: 'acp-sub-h' }, '最慢的轮次'),
            h('div', { className: 'acp-mini-list' }, ...v.slow.map((r, i) => h('div', { key: `${r.at}-${i}`, className: 'r', title: `${r.provider}/${r.model ?? 'default'} · ${fmtTime(r.at)}` },
              h(Prov, { color: colorOf(r.provider), name: nameOf(r.provider), model: modelOf(r.provider, r.model ?? 'default') }),
              h('b', null, dur(r.ms)))))) : null,
          v.tail.length ? h(Fragment, null,
            h('div', { className: 'acp-sub-h' }, `按模型 P90 · 近 ${v.sample} 轮`),
            h('div', { className: 'acp-mini-list' }, ...v.tail.map((m) => h('div', { key: m.key, className: 'r' },
              h('span', { className: 'nm', title: m.key }, modelOf(m.provider, m.model), h('small', { style: { color: 'var(--acp-muted)', marginLeft: 4 } }, `${m.turns} 轮`)),
              h('span', { className: 'bar' }, h('i', { style: { width: `${Math.max(4, (m.p90 / base) * 100)}%` } })),
              h('b', null, dur(m.p90)))))) : null)
          : h(Empty, { text: '所选范围内还没有成功轮次' }))
    }

    /** Cache efficiency card (s4). */
    function CacheCard({ usage, modelOf = rawModelOf, card }) {
      const v = cacheView(usage)
      return h(Card, { className: 's4', title: '缓存效率', sub: '读缓存占比', ...card },
        v.read + v.input > 0 ? h(Fragment, null,
          h('div', { className: 'acp-big' }, h('span', { className: 'v' }, `${v.ratio}%`), h('span', { className: 'u' }, '缓存读 / 输入总量')),
          h('div', { className: 'acp-meter' }, h('i', { style: { width: `${v.ratio}%`, background: 'var(--acp-out)' } })),
          h('div', { className: 'acp-note', style: { marginTop: 6 } }, `缓存读 ${compact(v.read)} · 实际输入 ${compact(v.input)} Token`),
          v.days.some((x) => x > 0) ? h(Fragment, null,
            h('div', { className: 'acp-sub-h' }, '按天缓存读'),
            h(Spark, { values: v.days, color: C_OUT })) : null,
          h('div', { className: 'acp-kv2' },
            h('div', null, h('div', { className: 'l' }, '缓存写 Token'), h('div', { className: 'v' }, compact(v.write))),
            h('div', null, h('div', { className: 'l' }, '字符数'), h('div', { className: 'v' }, compact(v.chars)))),
          v.byModel.length ? h(Fragment, null,
            h('div', { className: 'acp-sub-h' }, `按模型命中率 · 近 ${v.sample} 轮`),
            h('div', { className: 'acp-mini-list' }, ...v.byModel.slice(0, 3).map((m) => h('div', { key: m.key, className: 'r' },
              h('span', { className: 'nm', title: m.key }, modelOf(m.provider, m.model)),
              h('span', { className: 'bar' }, h('i', { style: { width: `${Math.max(2, m.ratio)}%` } })),
              h('b', null, `${m.ratio}%`))))) : null,
          h('div', { className: 'acp-note' }, v.full
            ? `缓存写 / 字符数为所选范围全量聚合${v.withWrite ? ` · 近 ${v.sample} 轮中 ${v.withWrite} 轮有缓存写` : ''}。`
            : `缓存写 / 字符数仅统计最近 ${v.sample} 条日志（后端未聚合该字段）${v.withWrite ? ` · ${v.withWrite} 轮有缓存写` : ''}。`))
          : h(Empty, { text: '所选范围内还没有缓存读记录' }))
    }

    /** Relative credit consumption card (s4). */
    function CreditCard({ providers, byModel, colorOf, nameOf, modelOf = rawModelOf, card }) {
      const v = creditView(providers, byModel)
      const top = v.rows.slice(0, 6)
      const max = Math.max(1, ...top.map((r) => r.credit))
      return h(Card, { className: 's4', title: '相对积分消耗', sub: '倍率 × Token', ...card },
        v.rows.length ? h(Fragment, null,
          h('div', { className: 'acp-big' }, h('span', { className: 'v' }, compact(v.total)), h('span', { className: 'u' }, '相对单位')),
          h('div', { className: 'acp-cr' }, ...top.map((r, i) => h('div', { key: r.key, className: 'row' },
            h('span', { className: 'no' }, String(i + 1)),
            h('span', { className: 'nm', title: r.key }, modelOf(r.provider, r.model), h('small', null, `${nameOf(r.provider)} · ${r.rate ?? '1x'}`)),
            h('span', { className: 'val' }, compact(r.credit)),
            h('span', { className: 'track' }, h('i', { style: { width: `${Math.max(2, (r.credit / max) * 100)}%`, background: colorOf(r.provider) } }))))),
          h('div', { className: 'acp-note' }, `按 CLI 模型倍率 × Token 估算，仅供参考、非实际金额。${v.unknown ? ` ${v.unknown} 个模型未标注倍率，按 1x 计入。` : ''}`))
          : h(Empty, { text: '所选范围内还没有调用记录' }))
    }

    /** Characters & throughput card (s4). */
    function ThroughputCard({ usage, modelOf = rawModelOf, card }) {
      const v = throughputView(usage)
      const tps = (x) => (x >= 100 ? n0(Math.round(x)) : x.toFixed(1))
      return h(Card, { className: 's4', title: '字符与吞吐', sub: '输出 Token / 秒', ...card },
        v.ms > 0 || v.chars > 0 ? h(Fragment, null,
          h('div', { className: 'acp-big' }, h('span', { className: 'v' }, tps(v.tps)), h('span', { className: 'u' }, 'Token/秒 · 输出')),
          h('div', { className: 'acp-kv2' },
            h('div', null, h('div', { className: 'l' }, '字符 / 输入 Token'), h('div', { className: 'v' }, v.ratio > 0 ? v.ratio.toFixed(2) : '-')),
            h('div', null, h('div', { className: 'l' }, '字符总量'), h('div', { className: 'v' }, compact(v.chars)))),
          v.byModel.length ? h(Fragment, null,
            h('div', { className: 'acp-sub-h' }, `按模型吞吐 · ${v.full ? '全量' : `近 ${v.sample} 轮`}`),
            h('div', { className: 'acp-mini-list' }, ...v.byModel.map((m) => h('div', { key: m.key, className: 'r', title: `${m.key} · ${m.turns} 轮` },
              h('span', { className: 'nm' }, modelOf(m.provider, m.model)),
              h('b', null, `${tps(m.tps)} t/s`))))) : null,
          h('div', { className: 'acp-note' }, `吞吐 = 输出 Token ÷ 轮次总耗时${v.full ? '' : `，仅统计最近 ${v.sample} 条日志（后端未聚合该字段）`}。估算轮次按字符 ÷ 4 计。`))
          : h(Empty, { text: '所选范围内还没有调用记录' }))
    }

    // ── per-model TPS trend (/api/llm-acp.tps), duration buckets, projects, session depth ──
    const TPS_WINS = [['day', '天'], ['week', '周'], ['month', '月']]
    const TPS_MODES = [['turn', '整轮'], ['gen', '生成']]
    const rateFmt = (x) => (num(x) >= 100 ? n0(Math.round(num(x))) : num(x).toFixed(1))
    /** Merge the host's 5-minute points into `step` buckets from their sums (exact, not averaged). */
    function mergeTps(points, step, gen) {
      const by = new Map()
      for (const p of points ?? []) {
        const t = Math.floor(num(p.t) / step) * step
        let b = by.get(t)
        if (!b) by.set(t, (b = { t, out: 0, ms: 0, genOut: 0, genMs: 0, turns: 0, estimated: 0 }))
        b.out += num(p.out); b.ms += num(p.ms); b.genOut += num(p.genOut); b.genMs += num(p.genMs); b.turns += num(p.turns); b.estimated += num(p.estimated)
      }
      return [...by.values()].sort((a, b) => a.t - b.t)
        .map((b) => ({ ...b, v: gen ? (b.genMs > 0 ? b.genOut / (b.genMs / 1000) : null) : (b.ms > 0 ? b.out / (b.ms / 1000) : null) }))
        .filter((b) => b.v !== null)
    }
    function TpsCard({ query, reloadKey, ttft, modelOf = rawModelOf, card }) {
      const [win, setWin] = useState('day')
      // Until the user picks a window, widen 天 → 周 → 月 when the narrower one has no data.
      const [autoWin, setAutoWin] = useState(true)
      const pickWin = (v) => { setAutoWin(false); setWin(v) }
      const [mode, setMode] = useState('turn')
      const [hidden, setHidden] = useState({})
      const [res, setRes] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => {
        let off = false
        getJson(`${R.tps}?window=${win}${query ? `&${query}` : ''}`).then((j) => {
          if (off) return
          if (autoWin && !(j.models ?? []).length && win !== 'month') { setWin(win === 'day' ? 'week' : 'month'); return }
          setRes(j); setErr('')
        }, (e) => { if (!off) setErr(String(e?.message ?? e)) })
        return () => { off = true }
      }, [win, query, reloadKey])
      // Month: 8640 five-minute buckets would be unreadable; merged into hours for drawing.
      const step = win === 'month' ? 3_600_000 : num(res?.step) || 300_000
      const genOk = (res?.models ?? []).some((m) => m.genTps !== undefined)
      const gen = mode === 'gen' && genOk
      const series = (res?.models ?? []).slice(0, 8).map((m, i) => ({ ...m, color: PALETTE[i % PALETTE.length], pts: mergeTps(m.points, step, gen) }))
      const vis = series.filter((s) => !hidden[s.key] && s.pts.length)
      const since = num(res?.since)
      const until = num(res?.until)
      const W = 640, H = 190, PL = 38, PR = 10, PT = 10, PB = 22
      const max = Math.max(1, ...vis.flatMap((s) => s.pts.map((p) => p.v))) * 1.1
      const X = (t) => PL + ((t + step / 2 - since) / Math.max(1, until - since)) * (W - PL - PR)
      const Y = (v) => PT + (1 - v / max) * (H - PT - PB)
      const tickFmt = (t) => { const d = new Date(t); return win === 'day' ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
      const ticks = until > since ? [0, 0.25, 0.5, 0.75, 1].map((f) => since + f * (until - since)) : []
      const pathOf = (pts) => pts.map((p, i) => `${i === 0 || p.t - pts[i - 1].t > step * 1.5 ? 'M' : 'L'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('')
      const turns = vis.reduce((a, s) => a + s.pts.reduce((b, p) => b + p.turns, 0), 0)
      const any = series.some((s) => s.pts.length)
      const seg = (opts, cur, set, label, disabledOf) => h('div', { className: 'acp-seg mini', role: 'tablist', 'aria-label': label },
        ...opts.map(([v, text]) => {
          const dis = disabledOf ? disabledOf(v) : false
          return h('button', { key: v, type: 'button', role: 'tab', 'aria-selected': String(cur === v), className: cur === v ? 'on' : '', disabled: dis, title: dis ? '还没有记录首字时间的轮次（新调用才有）' : undefined, onClick: () => set(v) }, text)
        }))
      const right = h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' } },
        seg(TPS_MODES, gen ? 'gen' : 'turn', setMode, 'TPS 口径', (v) => v === 'gen' && !genOk),
        seg(TPS_WINS, win, pickWin, 'TPS 时间窗'))
      const winText = win === 'day' ? '最近一天' : win === 'week' ? '最近一周' : '最近一个月'
      return h(Card, { className: 's8', title: '模型 TPS 趋势', right, ...card },
        err ? h('div', { className: 'acp-note', style: { color: 'var(--acp-err)' } }, /404/.test(err) ? '宿主还是旧版本：重启一次 DSH 后可用' : err) : null,
        !res && !err ? h('div', { className: 'acp-skel', style: { height: 190 } }) : null,
        res && !any ? h(Empty, { text: `${winText}没有成功且有输出的轮次` }) : null,
        res && any ? h('div', { className: 'acp-tps' },
          h('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `模型 TPS 趋势 · ${winText}` },
            ...[0, 0.5, 1].map((f) => h('g', { key: `y${f}` },
              h('line', { className: 'gl', x1: PL, x2: W - PR, y1: Y(max * f), y2: Y(max * f) }),
              h('text', { className: 'ax', x: PL - 5, y: Y(max * f) + 3, textAnchor: 'end' }, rateFmt(max * f)))),
            ...ticks.map((t, i) => h('text', { key: `x${i}`, className: 'ax', x: PL + (i / 4) * (W - PL - PR), y: H - 6, textAnchor: i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, tickFmt(t))),
            ...vis.map((s) => h('g', { key: s.key },
              h('path', { d: pathOf(s.pts), fill: 'none', stroke: s.color, strokeWidth: 1.8, strokeLinejoin: 'round', strokeLinecap: 'round' }),
              ...s.pts.map((p) => h('circle', { key: p.t, cx: X(p.t), cy: Y(p.v), r: s.pts.length > 60 ? 1.8 : 2.8, fill: p.estimated ? 'var(--acp-card)' : s.color, stroke: s.color, strokeWidth: 1.2 },
                h('title', null, `${modelOf(s.provider, s.model)} · ${fmtTime(p.t).slice(0, 11)}${win === 'month' ? ' 起 1 小时' : ''} · ${rateFmt(p.v)} t/s · ${p.turns} 轮${p.estimated ? ` · 其中 ${p.estimated} 轮按字符估算` : ''}`)))))),
          h('div', { className: 'acp-lg' }, ...series.map((s) => {
            const avg = gen ? s.genTps : s.tps
            return h('button', { key: s.key, type: 'button', className: hidden[s.key] ? 'off' : '', disabled: !s.pts.length, 'aria-pressed': String(!hidden[s.key]), title: `${s.key} · ${s.turns} 轮${s.ttft ? ` · 首字 P50 ${dur(s.ttft.p50)}` : ''} · 点击显示 / 隐藏`, onClick: () => setHidden((x) => ({ ...x, [s.key]: !x[s.key] })) },
              h('i', { style: { background: s.color } }), h('span', null, modelOf(s.provider, s.model)), avg !== undefined ? h('b', null, `${rateFmt(avg)} t/s`) : null)
          }))) : null,
        res ? h('div', { className: 'acp-note' },
          `${win === 'month' ? '按 1 小时合并' : '5 分钟一格'} · 共 ${n0(turns)} 轮 · `,
          gen ? '生成 TPS = 输出 Token ÷（耗时 − 首字时间），只统计记录了首字时间的轮次' : '整轮 TPS = 输出 Token ÷ 整轮耗时，含 CLI 跑工具的时间，比纯生成速度低',
          ` · 首字时间${num(ttft?.count) ? ` P50 ${dur(ttft.p50)} · P90 ${dur(ttft.p90)}（${n0(ttft.count)} 轮）` : '：新调用的轮次才会记录'}`,
          ' · 空心点含估算 Token') : null)
    }

    function DurationCard({ usage, colorOf, nameOf, card }) {
      const bins = usage?.durations ?? []
      const total = bins.reduce((a, b) => a + num(b.count), 0)
      const max = Math.max(1, ...bins.map((b) => num(b.count)))
      const top = bins.reduce((a, b) => (num(b.count) > num(a?.count) ? b : a), undefined)
      const provs = [...new Set(bins.flatMap((b) => Object.keys(b.models ?? {}).map(providerOfKey)))]
      return h(Card, { className: 's4', title: '耗时分布', sub: '成功轮次 · 按提供方着色', ...card },
        total ? h(Fragment, null,
          ...bins.map((b) => h('div', { key: b.label, className: 'acp-drow' },
            h('span', null, b.label),
            h('div', { className: 'acp-hbar' }, num(b.count) ? h('div', { className: 'fill', style: { width: `${(num(b.count) / max) * 100}%` } },
              ...Object.entries(b.models ?? {}).map(([k, c]) => h('i', { key: k, title: `${k} · ${c} 轮`, style: { flex: c, background: colorOf(providerOfKey(k)) } }))) : null),
            h('b', null, n0(b.count), h('small', null, pct(b.count, total))))),
          provs.length ? h('div', { className: 'acp-legend wrap' }, ...provs.map((pid) => h('span', { key: pid }, h('i', { style: { background: colorOf(pid) } }), nameOf(pid)))) : null,
          h('div', { className: 'acp-note' }, `最常见 ${top?.label ?? '-'}（${pct(top?.count, total)}）· P50 ${dur(usage?.latency?.p50)} · P90 ${dur(usage?.latency?.p90)}`))
          : h(Empty, { text: usage?.durations ? '所选范围内还没有成功的轮次' : '宿主还是旧版本：重启一次 DSH 后可用' }))
    }

    const baseOf = (p) => { const s = String(p ?? '').replace(/\/+$/, ''); return s ? s.split('/').pop() || s : '' }
    function ProjectCard({ usage, card }) {
      const rows = usage?.byProject ?? []
      const max = Math.max(1, ...rows.map(tokOf))
      return h(Card, { className: 's4', title: '项目排行', sub: `按 Token · ${n0(usage?.projectCount ?? rows.length)} 个目录`, ...card },
        rows.length ? h(Fragment, null,
          h('div', { className: 'acp-mini-list' }, ...rows.slice(0, 8).map((p, i) => h('div', { key: p.cwd || `-${i}`, className: 'r', title: `${p.cwd || '未记录工作目录'}\n${n0(p.turns)} 轮 · ${n0(p.sessions)} 个会话 · ${n0(tokOf(p))} Token` },
            h('span', { style: { width: 14, flex: 'none', color: 'var(--acp-faint)', fontVariantNumeric: 'tabular-nums' } }, i + 1),
            h('span', { className: 'nm', style: { color: 'var(--acp-fg)' } }, baseOf(p.cwd) || '（未记录目录）'),
            h('small', { style: { flex: 'none', color: 'var(--acp-faint)' } }, `${n0(p.sessions)} 会话 · ${n0(p.turns)} 轮`),
            h('span', { className: 'bar' }, h('i', { style: { width: `${(tokOf(p) / max) * 100}%`, background: 'var(--acp-in)' } })),
            h('b', null, compact(tokOf(p)))))),
          h('div', { className: 'acp-note' }, '目录 = 会话的工作目录，悬停看完整路径。'))
          : h(Empty, { text: usage?.byProject ? '所选范围内还没有调用记录' : '宿主还是旧版本：重启一次 DSH 后可用' }))
    }

    function DepthCard({ usage, card }) {
      const d = usage?.depth
      const grow = (d?.byIndex ?? []).filter((b) => b.count > 0)
      const gmax = Math.max(1, ...grow.map((b) => b.avgIn))
      return h(Card, { className: 's4', title: '会话深度', sub: `${n0(d?.sessions)} 个会话`, ...card },
        d && d.sessions ? h(Fragment, null,
          h('div', { className: 'acp-big' }, h('span', { className: 'v' }, d.avgTurns.toFixed(1)), h('span', { className: 'u' }, `轮 / 会话 · 最长 ${n0(d.maxTurns)} 轮`)),
          h('div', { className: 'acp-kv2' },
            h('div', null, h('div', { className: 'l' }, '单轮输入'), h('div', { className: 'v' }, compact(d.avgIn))),
            h('div', null, h('div', { className: 'l' }, '单轮输出 · 输入:输出'), h('div', { className: 'v' }, compact(d.avgOut), h('small', { style: { color: 'var(--acp-muted)', fontWeight: 400, marginLeft: 6 } }, d.ratio > 0 ? `${d.ratio.toFixed(1)} : 1` : '-')))),
          h('div', { className: 'acp-chips-row' }, ...d.dist.map((b) => h(Chip, { key: b.label }, `${b.label} ${n0(b.count)}`))),
          grow.length > 1 ? h(Fragment, null,
            h('div', { className: 'acp-sub-h' }, '第 N 轮的平均输入 Token（上下文增长）'),
            h('div', { className: 'acp-grow' }, ...grow.map((b) => h('div', { key: b.i, className: 'c', title: `第 ${b.label} 轮：平均输入 ${n0(Math.round(b.avgIn))} · 输出 ${n0(Math.round(b.avgOut))} · ${b.count} 轮` },
              h('i', { style: { height: `${(b.avgIn / gmax) * 100}%` } })))),
            h('div', { className: 'acp-grow-ax' }, ...grow.map((b) => h('span', { key: b.i }, b.label)))) : null,
          h('div', { className: 'acp-note' }, '只统计带会话 ID 的轮次。'))
          : h(Empty, { text: usage?.depth ? '所选范围内还没有会话' : '宿主还是旧版本：重启一次 DSH 后可用' }))
    }

    /** Data-quality strip: replaces the old one-line estimated note. */
    function QualityStrip({ usage, modelOf = rawModelOf }) {
      const v = qualityView(usage)
      if (v.estimated <= 0) return null
      return h('div', { className: 'acp-quality' },
        h('span', null, h('b', null, n0(v.estimated)), ` / ${n0(v.turns)} 轮未上报 Token，按字符数 ÷ 4 估算（表格标 *）`),
        h('span', { className: 'bar' }, h('i', { style: { width: `${v.ratio}%` } })),
        h('span', null, '估算占比 ', h('b', null, `${v.ratio}%`)),
        ...v.byModel.map((m) => h('span', { key: m.key, className: 'chip', title: m.key }, `${modelOf(providerOfKey(m.key), m.model)} ${m.turns} 轮`)))
    }

    /** Heatmap card with a metric toggle (turns / tokens / failed). */
    const HEAT_METRICS = [['turns', '轮次'], ['tokens', 'Token'], ['failed', '失败']]
    function HeatmapCard({ cells, metric: metricProp, onMetric, card }) {
      const [metricLocal, setMetricLocal] = useState('turns')
      const metric = metricProp ?? metricLocal
      const setMetric = onMetric ?? setMetricLocal
      const right = h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' } },
        h('span', { className: 'acp-tt-l' }, '近 12 周'),
        h('div', { className: 'acp-seg mini', role: 'tablist', 'aria-label': '热力图指标' },
          ...HEAT_METRICS.map(([v, label]) => h('button', { key: v, type: 'button', role: 'tab', 'aria-selected': String(metric === v), className: metric === v ? 'on' : '', onClick: () => setMetric(v) }, label))))
      return h(Card, { className: 's4 m6', title: '活跃热力图', right, ...card }, h(Heatmap, { cells: cells ?? [], metric }))
    }

    /** Error distribution with a click-to-open detail (full message, model, first/last seen). */
    function ErrorCard({ usage, nameOf, modelOf = rawModelOf, card }) {
      const v = errorView(usage)
      const [openCode, setOpenCode] = useState('')
      if (!v.codes.length) return null
      const maxE = Math.max(1, ...v.codes.map((x) => num(x.count)))
      const peak = Math.max(0, ...v.byDay.map((d) => d.rate))
      return h(Card, { className: 's5', title: '错误分布', sub: `${n0(v.total)} 次 · 点击查看详情`, ...card },
        peak > 0 ? h(Fragment, null,
          h('div', { className: 'acp-sub-h', style: { marginTop: 0 } }, '按天失败率'),
          h(Spark, { values: v.byDay.map((d) => d.rate), color: 'var(--acp-err)' }),
          h('div', { className: 'acp-note' }, `峰值 ${peak}%`)) : null,
        h('div', { className: 'acp-rank' }, ...v.codes.slice(0, 6).map((e) => {
          const on = openCode === e.code
          const toggle = () => setOpenCode(on ? '' : e.code)
          return h(Fragment, { key: e.code },
            h('div', { className: `r click${on ? ' sel' : ''}`, role: 'button', tabIndex: 0, title: e.message ?? '点击查看错误详情',
              onClick: toggle, onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle() } } },
              h('span', { className: 'no' }, '!'),
              h('span', { className: 'nm acp-mono', style: { color: 'var(--acp-err)' } }, e.code, h('small', null, `${nameOf(e.provider)} · ${ago(e.lastAt)}`)),
              h('span', { className: 'val' }, h('b', null, n0(e.count)), ' 次'),
              h('span', { className: 'track' }, h('i', { style: { width: `${(num(e.count) / maxE) * 100}%`, background: 'linear-gradient(90deg,color-mix(in srgb,var(--acp-err) 45%,#fff),var(--acp-err))' } }))),
            on ? h('dl', { className: 'acp-errd' },
              h('dt', null, '信息'), h('dd', { className: 'acp-mono' }, e.message || '（CLI 未提供错误信息）'),
              h('dt', null, '涉及'), h('dd', { title: `${e.provider}/${e.model ?? 'default'}` }, `${nameOf(e.provider)} · ${modelOf(e.provider, e.model ?? 'default')}`),
              h('dt', null, '最近'), h('dd', null, `${fmtTime(e.lastAt)} · ${ago(e.lastAt)}`),
              e.firstAt ? h('dt', null, '最早') : null, e.firstAt ? h('dd', null, `${fmtTime(e.firstAt)}（近 ${v.sample} 轮内）`) : null) : null)
        })))
    }

    /** Dynamic usage/account probe card: one row per provider showing whatever its CLI reports
     *  non-interactively (tier / local cost / token counts / account type). Not a balance. */
    function QuotaCard({ providers, colorOf, nameOf, card, busy, onRefresh }) {
      const v = quotaView(providers, colorOf, nameOf)
      const STATUS_CHIP = { ok: ['ok', '已获取'], error: ['fail', '探测失败'], unsupported: ['', '不支持'], empty: ['', '无数据'], loading: ['brand', '探测中'] }
      return h(Card, {
        className: 's12', title: 'CLI 用量/额度探测',
        sub: `${v.ok}/${v.total} 个 CLI 可查询 · 非账户余额`,
        right: h('button', { type: 'button', className: 'acp-quota-refresh', disabled: !!busy, onClick: onRefresh, title: '重新运行各 CLI 的用量探测命令' }, busy ? '探测中…' : '刷新'),
        ...card,
      },
        v.rows.length ? h('div', null, v.rows.map((r) => {
          const [kind, label] = STATUS_CHIP[r.status] ?? ['', r.status]
          return h('div', { key: r.id, className: 'acp-quota-row' },
            h('div', { className: 'nm' }, h('i', { className: 'dot', style: { background: r.color } }), h('span', null, r.name)),
            h('div', { className: 'ago' }, h(Chip, { kind }, label), r.probedAt ? ` · ${ago(r.probedAt)}` : ''),
            h('div', { className: 'det', title: r.excerpt || r.detail }, r.detail,
              r.source ? h('span', { className: 'src' }, `（${r.source}）`) : null))
        })) : h(Empty, { text: '还没有接入任何 CLI' }))
    }

    /** Error classes (限流 / 额度 / 认证 …) with a stacked share bar — visible in every entry,
     *  including the ACP 洞察 page. Clicking a class filters the console by its raw codes is not
     *  offered (codes are heterogeneous); the raw-code drill-down stays in ErrorCard. */
    function ErrorClassCard({ usage, card }) {
      const v = errorView(usage)
      if (!v.classes.length) return null
      const maxC = Math.max(1, ...v.classes.map((x) => x.count))
      return h(Card, { className: 's12', title: '错误类别', sub: `${n0(v.total)} 次 · ${v.classes.length} 类`, ...card },
        h('div', { className: 'acp-ecbar', role: 'img', 'aria-label': '错误类别占比' },
          ...v.classes.map((c) => h('i', { key: c.key, title: `${c.label} ${n0(c.count)} 次`, style: { width: `${(num(c.count) / Math.max(1, v.total)) * 100}%`, background: c.color } }))),
        h('div', null, ...v.classes.map((c) => h('div', { key: c.key, className: 'acp-ecrow' },
          h('i', { className: 'dot', style: { background: c.color } }),
          h('span', { className: 'nm' }, c.label, h('small', { className: 'acp-mono', title: c.codes.join(', ') }, c.codes.join(' / '))),
          h('span', { className: 'n' }, n0(c.count), ' 次'),
          h('span', { className: 'p' }, pct(c.count, v.total))))))
    }

    /** Elapsed-vs-timeout meter for an in-flight row. */
    function TimeoutCell({ f, p }) {
      const v = timeoutView(f, p)
      if (v.limit <= 0) return h('span', { style: { color: 'var(--acp-faint)' } }, '-')
      return h('div', { className: `acp-tm${v.over ? ' over' : v.near ? ' near' : ''}`, title: `单轮超时 ${dur(v.limit)} · 已运行 ${dur(v.elapsed)}${v.over ? ' · 已超时' : ` · 剩余 ${dur(v.remaining)}`}` },
        h('span', { className: 'bar' }, h('i', { style: { width: `${v.ratio * 100}%` } })),
        h('span', null, v.over ? '超时' : `${Math.round(v.ratio * 100)}%`))
    }

    function Skeleton() {
      return h(Fragment, null,
        h('div', { className: 'acp-kpis' }, ...[0, 1, 2, 3, 4, 5].map((i) => h('div', { key: i, className: 'acp-skel', style: { height: 92 } }))),
        h('div', { className: 'acp-grid' }, h('div', { className: 'acp-skel s8', style: { height: 230 } }), h('div', { className: 'acp-skel s4', style: { height: 230 } })),
        h('div', { className: 'acp-note', style: { textAlign: 'center' } }, '首次打开需要询问每个 CLI 的模型列表，可能要几秒…'))
    }

    // ── page ──
    // mode: 'sidebar' (right-sidebar tab), 'page' (first-level ACP 洞察 page, wide layout),
    // 'session' (/acp modal: lockSession pins every card to that one session).
    function Console(props) {
      const mode = props?.mode ?? 'sidebar'
      const lockSession = typeof props?.lockSession === 'string' ? props.lockSession : ''
      const [prefs0] = useState(loadPrefs)
      const [range, setRange] = useState(lockSession ? '0' : (prefs0.range ?? '7'))
      const [customOn, setCustomOn] = useState(prefs0.customOn ?? false)
      const [fromStr, setFromStr] = useState(prefs0.from ?? '')
      const [toStr, setToStr] = useState(prefs0.to ?? '')
      const [compare, setCompare] = useState(prefs0.compare ?? false)
      const [filter, setFilterRaw] = useState(lockSession ? { session: lockSession } : (prefs0.filter ?? {}))
      // A locked session view must never lose (or persist) its session filter.
      const setFilter = lockSession
        ? (next) => setFilterRaw((cur) => ({ ...(typeof next === 'function' ? next(cur) : next), session: lockSession }))
        : setFilterRaw
      const [chartType, setChartType] = useState(prefs0.chartType ?? 'stacked')
      const [chartDim, setChartDim] = useState(prefs0.chartDim ?? 'io')
      const [heatMetric, setHeatMetric] = useState(prefs0.heatMetric ?? 'turns')
      const [sdMetric, setSdMetric] = useState(prefs0.sdMetric ?? 'tokens')
      const [sdGroup, setSdGroup] = useState(prefs0.sdGroup ?? 'model')
      const [sdView, setSdView] = useState(prefs0.sdView ?? 'bars')
      const [compactMode, setCompactMode] = useState(prefs0.compact ?? false)
      const [collapsed, setCollapsed] = useState(prefs0.collapsed ?? {})
      const [tbl, setTbl] = useState(prefs0.tbl ?? { result: 'all', model: '', q: '', sort: 'at', dir: -1 })
      const [data, setData] = useState(props?.__data ?? null)
      const [err, setErr] = useState('')
      const [loading, setLoading] = useState(false)
      const [busy, setBusy] = useState('')
      const [open, setOpenMap] = useState({})
      const [editor, setEditor] = useState(null)
      // 「配置 CLI」 tag: the scan card stays folded until the user asks for it.
      const [discOpen, setDiscOpen] = useState(false)
      const [discSeen, setDiscSeen] = useState(typeof prefs0.discSeen === 'number' ? prefs0.discSeen : undefined)
      const discRef = useRef(null)
      const discScroll = useRef(false)
      const [toast, setToast] = useState('')
      const [auto, setAuto] = useState(true)
      const [recentN, setRecentN] = useState(15)
      const [selFlight, setSelFlight] = useState('')
      const [selSession, setSelSession] = useState('')
      const [drill, setDrill] = useState(null)
      const [report, setReport] = useState(null)
      const [copied, setCopied] = useState(false)
      const entries = useStore(entryStore)
      const seq = useRef(0)
      const quotaRefreshNext = useRef(false)
      const fromMs = fromStr ? Date.parse(`${fromStr}T00:00:00`) : NaN
      const toMs = toStr ? Date.parse(`${toStr}T00:00:00`) + 86_399_999 : NaN
      const customValid = customOn && Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs <= toMs
      const filterQuery = () => ['provider', 'model', 'session'].filter((k) => filter[k]).map((k) => `${k}=${encodeURIComponent(filter[k])}`).join('&')
      const query = (extra) => {
        const parts = customValid ? ['range=0', `from=${fromMs}`, `to=${toMs}`] : [`range=${encodeURIComponent(range)}`]
        if (compare && (customValid || range !== '0')) parts.push('compare=1')
        const fq = filterQuery()
        if (fq) parts.push(fq)
        if (extra) parts.push(extra)
        return parts.join('&')
      }
      const load = useCallback(async () => {
        const my = ++seq.current
        setLoading(true)
        let extra = ''
        if (quotaRefreshNext.current) { quotaRefreshNext.current = false; extra = 'quotaRefresh=1' }
        try {
          const j = await getJson(`${R.dashboard}?${query(extra)}`)
          if (my === seq.current) { setData(j); setErr('') }
        } catch (e) { if (my === seq.current) setErr(String(e?.message ?? e)) }
        finally { if (my === seq.current) setLoading(false) }
      }, [range, customValid, fromMs, toMs, compare, filter])
      useEffect(() => { load() }, [load])
      useEffect(() => {
        if (!auto) return undefined
        const t = setInterval(() => { if (!document.hidden) load() }, 15_000)
        return () => clearInterval(t)
      }, [auto, load])
      // The host answers fast and marks slow CLI probes (models / --version / quota) as pending;
      // poll again shortly until every card is filled in. The work is not restarted per poll.
      useEffect(() => {
        if (!data?.pending) return undefined
        const t = setTimeout(() => { load() }, 1500)
        return () => clearTimeout(t)
      }, [data, load])
      useEffect(() => {
        // A locked /acp session view must not overwrite the sidebar's saved range/filter.
        if (lockSession) return
        savePrefs({ range, customOn, from: fromStr, to: toStr, compare, filter, chartType, chartDim, heatMetric, sdMetric, sdGroup, sdView, compact: compactMode, collapsed, tbl })
      }, [lockSession, range, customOn, fromStr, toStr, compare, filter, chartType, chartDim, heatMetric, sdMetric, sdGroup, sdView, compactMode, collapsed, tbl])
      const act = async (key, fn) => {
        setBusy(key); setErr('')
        try { await fn(); await load() } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy('') }
      }
      const refreshQuota = async () => {
        quotaRefreshNext.current = true
        setBusy('quota'); setErr('')
        try { await load() } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy('') }
      }
      const fold = (key) => ({ collapsed: !!collapsed[key], onToggle: () => setCollapsed((c) => ({ ...c, [key]: !c[key] })) })
      const pickModel = (pid, mid) => setFilter((cur) => cur.provider === pid && cur.model === mid ? {} : { provider: pid, model: mid })
      const pickProvider = (pid) => setFilter((cur) => cur.provider === pid && !cur.model ? {} : { provider: pid })
      const pickSession = (sid) => setFilter((cur) => cur.session === sid && !cur.provider && !cur.model ? {} : { session: sid })
      const pickSessKey = (sid, key, group) => setFilter((cur) => {
        const next = group === 'provider' ? { session: sid, provider: key } : { session: sid, provider: providerOfKey(key), model: modelName(key) }
        return cur.session === sid && cur.provider === next.provider && (cur.model ?? '') === (next.model ?? '') ? {} : next
      })
      const pickKey = (key, group) => (group === 'provider' ? pickProvider(key) : pickModel(providerOfKey(key), modelName(key)))
      const openDrill = async (date) => {
        if (drill?.date === date) { setDrill(null); return }
        const start = Date.parse(`${date}T00:00:00`)
        setDrill({ date, loading: true })
        try {
          const fq = filterQuery()
          const j = await getJson(`${R.dashboard}?range=0&from=${start}&to=${start + 86_399_999}${fq ? `&${fq}` : ''}`)
          setDrill({ date, payload: j })
        } catch (e) { setDrill({ date, error: String(e?.message ?? e) }) }
      }

      const providers = data?.providers ?? []
      // Scan card: folded by default (always shown while no provider exists). A quiet background
      // scan, once per page load, feeds the tag's count; the guide animation invites a click the
      // first time and whenever more CLIs can be added than when the card was last opened.
      const disc = useStore(discStore)
      const discFresh = (disc.res?.candidates ?? []).filter((c) => !c.configuredAs).length
      const discShown = !lockSession && (discOpen || (!!data && providers.length === 0))
      // Tag highlight: always on while the card is folded and something can be added (or the card
      // was never opened). The hint bubble is the on-demand part: first time, or more CLIs than
      // when the card was last opened / the bubble was dismissed.
      const discGuide = !lockSession && !discShown && (discFresh > 0 || discSeen === undefined)
      const knownIds = providers.map((p) => p.id).join(',')
      useEffect(() => {
        if (lockSession || !data) return
        const s = discStore.get()
        if (!s.res && !s.err && !s.loading) runDiscover({ known: knownIds, visible: false })
      }, [!!data])
      const toggleDisc = () => {
        const next = !discOpen
        setDiscOpen(next)
        if (next) { setDiscSeen(discFresh); savePrefs({ discSeen: discFresh }); discScroll.current = true }
      }
      // The hint bubble stays up as long as the tag is highlighted (card folded, something to add);
      // it waits for the background scan, so its count is real.
      const discCoach = discGuide && !!disc.res && !disc.loading
      useEffect(() => {
        if (!discShown || !discScroll.current) return
        discScroll.current = false
        try { discRef.current?.scrollIntoView?.({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }) } catch {}
      }, [discShown])
      // An older host sends no canSave; its routes would 404 anyway, so only an explicit false hides saving.
      const canSave = data?.canSave !== false
      const onSaved = (msg) => {
        setEditor(null); setToast(msg)
        setTimeout(() => setToast(''), 3500)
        act('saved', () => sleep(1800)) // the plugin restarts with the new config before the reload
      }
      // Card-level delete: same route as the editor's 删除 button (removes the provider from the
      // plugin config; the plugin then restarts), so a disabled provider can actually go away.
      const removeProv = (p) => {
        const nm = short(p.displayName) || p.id
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(`从配置里删除「${nm}」（${p.id}）？\n\n删除后它不再出现在控制台和模型列表里；已有会话里引用 ${p.id}/<model> 的地方会报错。以后可以在「本机 ACP CLI」里重新添加。`)) return
        act(`x:${p.id}`, async () => {
          await post(R.remove, { id: p.id })
          setToast(`已删除 ${nm}，插件正在重载`)
          setTimeout(() => setToast(''), 3500)
          await sleep(1800) // let the plugin restart before the reload
        })
      }
      const usage = data?.usage ?? { total: {}, byProvider: [], byModel: [], byDay: [], errors: [], recent: [], hours: [], latency: {} }
      const t = usage.total ?? {}
      const days = usage.byDay ?? []
      const multi = days.length > 1
      const colorOf = (id) => PALETTE[Math.max(0, providers.findIndex((p) => p.id === id)) % PALETTE.length]
      const nameOf = (id) => short(providers.find((p) => p.id === id)?.displayName ?? id)
      const provOf = (id) => providers.find((p) => p.id === id)
      // Accurate names: model ids → the CLI catalog's display names (qmodel_latest → Qwen4-Max-Preview);
      // session ids → the project directory they ran in (from the host's session directory / turn cwd).
      const modelNames = {}
      for (const p of providers) for (const m of p.models ?? []) if (m.name) modelNames[`${p.id}/${m.id}`] = m.name
      const modelOf = (pid, id) => (id ?? 'default') === 'default' ? 'default' : modelNames[`${pid}/${id}`] ?? id
      const sessDir = {}
      for (const s of data?.sessions ?? []) if (s?.session && s.cwd) sessDir[s.session] = s
      // bySession / recent slices carry cwd:'' when no turn recorded one — fall through to the
      // session directory (|| not ??) so those sessions still get their project name.
      const sessInfo = (id, cwd) => { const c = cwd || sessDir[id]?.cwd; return c ? { cwd: c, project: projectOf(c) } : null }
      const sessText = (id, cwd) => { const info = sessInfo(id, cwd); return info ? `${info.project} · ${sess(id)}` : sess(id) }
      const sessTitle = (id, cwd) => { const info = sessInfo(id, cwd); return [info?.cwd, id].filter(Boolean).join('\n') || undefined }
      const enabled = providers.filter((p) => p.enabled).length
      const healthy = providers.filter((p) => p.enabled && p.status === 'ok').length
      const live = providers.reduce((s, p) => s + num(p.runtime?.liveChildren), 0)
      const warm = providers.reduce((s, p) => s + num(p.runtime?.warmSessions), 0)
      const inflight = providers.flatMap((p) => (p.runtime?.inflight ?? []).map((f) => ({ ...f, name: short(p.displayName) }))).sort((a, b) => a.startedAt - b.startedAt)
      const selF = inflight.find((f) => flightKey(f) === selFlight)
      const modelsOn = providers.reduce((s, p) => s + (p.models ?? []).filter((m) => !m.disabled).length, 0)
      const modelsAll = providers.reduce((s, p) => s + (p.models ?? []).length, 0)
      const success = pctN(num(t.ok), num(t.turns))
      const sColor = success >= 90 ? '#10b981' : success >= 60 ? '#f59e0b' : '#f43f5e'
      const rangeLabel = customValid ? `${fromStr} ~ ${toStr}` : (RANGES.find(([v]) => v === range) ?? [])[1] ?? ''
      const share = providers.map((p) => { const u = usage.byProvider.find((x) => x.provider === p.id); return { key: p.id, label: short(p.displayName), color: colorOf(p.id), value: tokOf(u), text: compact(tokOf(u)), title: `${short(p.displayName)}：${compact(tokOf(u))} Token · ${num(u?.turns)} 轮` } })
      const star = (r) => (r.estimated ? '*' : '')
      // Host capability echoes: an old host ignores from/to, filter and compare.
      const filterOn = Object.keys(filter).length > 0
      const compareOn = compare && (customValid || range !== '0')
      const hostFilterOk = !filterOn || !!data?.filter
      const hostCustomOk = !customValid || data?.from !== undefined
      const hostCompareOk = !compareOn || !!data?.prev
      const hostStale = !!data && (!hostFilterOk || !hostCustomOk || !hostCompareOk)
      const filterLabel = [filter.provider && nameOf(filter.provider), filter.model && modelOf(filter.provider, filter.model), filter.session && sessText(filter.session)].filter(Boolean).join(' / ')
      const prevValues = data?.prev?.byDay?.map((d) => num(d.inputTokens) + num(d.outputTokens))
      // Recent-call table: result / model / session filters + column sort.
      const resultOf = (r) => (r.ok ? 'ok' : (r.aborted || r.code === 'DISPOSED') ? 'aborted' : 'failed')
      let recentRows = usage.recent.filter((r) => tbl.result === 'all' || resultOf(r) === tbl.result)
      if (tbl.model) recentRows = recentRows.filter((r) => modelKey(r) === tbl.model)
      if (tbl.q) { const q = tbl.q.toLowerCase(); recentRows = recentRows.filter((r) => String(r.session ?? '').toLowerCase().includes(q) || sessText(r.session, r.cwd).toLowerCase().includes(q)) }
      recentRows = recentRows.slice().sort((a, b) => (num(a[tbl.sort]) - num(b[tbl.sort])) * tbl.dir)
      const recentModels = [...new Set(usage.recent.map(modelKey))]
      const selSessRec = selSession ? usage.recent.find((r) => r.session === selSession) : null
      // Day drill-down panel (rendered inside the trend card).
      let drillPanel = null
      if (drill) {
        const dv = drill.payload ? dayDrill(drill.date, drill.payload, usage.recent) : null
        drillPanel = h('div', { className: 'acp-drill' },
          h('div', { className: 'acp-sub-h', style: { display: 'flex', alignItems: 'center' } }, `${drill.date} 下钻${dv && !dv.exact ? ' · 宿主未更新，仅最近 100 轮窗口内的记录' : ''}`,
            h('button', { type: 'button', className: 'acp-btn', style: { marginLeft: 'auto', padding: '1px 8px', fontSize: 11 }, onClick: () => setDrill(null) }, '关闭')),
          drill.loading ? h('div', { className: 'acp-note' }, '正在读取当天数据…')
            : drill.error ? h('div', { className: 'acp-note', style: { color: 'var(--acp-err)' } }, drill.error)
              : dv ? h(Fragment, null,
                h('div', { className: 'acp-kv2' },
                  h('div', null, h('div', { className: 'l' }, '轮次'), h('div', { className: 'v' }, n0(dv.total.turns))),
                  h('div', null, h('div', { className: 'l' }, 'Token'), h('div', { className: 'v' }, compact(num(dv.total.inputTokens) + num(dv.total.outputTokens)))),
                  h('div', null, h('div', { className: 'l' }, '失败'), h('div', { className: 'v' }, n0(dv.total.failed))),
                  h('div', null, h('div', { className: 'l' }, '成功率'), h('div', { className: 'v' }, pct(dv.total.ok, dv.total.turns)))),
                h('div', { className: 'acp-sub-h' }, '当天 24h 分布'),
                h(HourChart, { hours: dv.hours }),
                dv.sessions.length ? h(Fragment, null,
                  h('div', { className: 'acp-sub-h' }, `当天会话 · ${dv.sessions.length} 个${dv.exact && dv.rows.length >= 100 ? '（仅最近 100 轮）' : ''}`),
                  h('div', { className: 'acp-scroll' }, h('table', { className: 'acp-table' },
                    h('thead', null, h('tr', null, ...['会话', '轮次', 'Token', '最近', ''].map((x, i) => h('th', { key: i, className: i === 1 || i === 2 ? 'num' : undefined }, x)))),
                    h('tbody', null, ...dv.sessions.slice(0, 10).map((s) => h('tr', { key: s.session || 'none' },
                      h('td', { title: sessTitle(s.session, s.cwd) }, s.session ? sessText(s.session, s.cwd) : '（无会话标识）'),
                      h('td', { className: 'num' }, n0(s.turns)),
                      h('td', { className: 'num' }, compact(s.tokens)),
                      h('td', null, ago(s.lastAt)),
                      h('td', null, s.session ? h('button', { type: 'button', className: 'acp-link', onClick: () => { setFilter({ session: s.session }); setDrill(null) } }, '筛选此会话') : null))))))) : null,
                !dv.rows.length ? h('div', { className: 'acp-note' }, '这一天在日志窗口内没有调用记录。') : null) : null)
      }

      return h('div', { className: `acp${compactMode ? ' compact' : ''}${mode === 'page' ? ' acp-page' : ''}` },
        h('style', null, CSS),
        mode === 'page' ? h('div', { className: 'acp-pagehead' },
          h('h1', null, 'ACP 洞察'),
          h('span', { className: 'sub' }, '全部会话的 ACP CLI 状态、模型与 Token 用量；点图表 / 会话行可交叉筛选，↗ 直接打开对应会话。')) : null,
        h('div', { className: 'acp-hero' },
          h('div', { className: 'acp-row' },
            h('div', { className: 'acp-logo' }, h(Icon, { width: 18, height: 18, strokeWidth: 1.8 })),
            h('div', null,
              h('div', { className: 'acp-h1' }, mode === 'page' ? 'ACP 控制台' : lockSession ? `本会话 · ${sessText(lockSession)}` : 'ACP 控制台'),
              h('div', { className: 'acp-hsub' }, lockSession ? '所有卡片已锁定到这个会话' : data ? `${providers.length} 个 CLI · ${modelsAll} 个模型 · ${loading ? '刷新中…' : data.pending ? '部分信息后台读取中…' : `更新于 ${fmtTime(data.generatedAt).slice(6)}`}` : '正在读取…')),
            h('span', { className: 'acp-sp' }),
            inflight.length ? h('span', { className: 'acp-live' }, h('i'), `进行中 ${inflight.length} 轮`) : null),
          h('div', { className: 'acp-ctl' },
            h('div', { className: 'acp-seg', role: 'tablist', 'aria-label': '时间范围' },
              ...RANGES.map(([v, label]) => h('button', { key: v, type: 'button', role: 'tab', 'aria-selected': !customOn && range === v, className: !customOn && range === v ? 'on' : '', onClick: () => { setCustomOn(false); setRange(v) } }, label)),
              h('button', { key: 'custom', type: 'button', role: 'tab', 'aria-selected': customOn, className: customOn ? 'on' : '', title: '自定义起止日期', onClick: () => setCustomOn(!customOn) }, '自定义')),
            customOn ? h(Fragment, null,
              h('input', { type: 'date', className: 'acp-date', value: fromStr, 'aria-label': '开始日期', onChange: (e) => setFromStr(e.target.value) }),
              h('span', { className: 'acp-tt-l' }, '至'),
              h('input', { type: 'date', className: 'acp-date', value: toStr, 'aria-label': '结束日期', onChange: (e) => setToStr(e.target.value) })) : null,
            h('button', { type: 'button', className: `acp-btn${compare ? ' on' : ''}`, disabled: !customValid && range === '0', title: '与上一个等长周期对比（KPI 环比 + 趋势图灰色虚线）', onClick: () => setCompare(!compare) }, '环比'),
            h('span', { className: 'acp-sp' }),
            lockSession ? null : h('span', { className: 'acp-cfg-wrap' },
              h('button', {
                type: 'button', className: `acp-btn acp-cfg${discShown ? ' on' : ''}${discGuide ? ' guide' : ''}`, 'aria-expanded': String(discShown),
                title: discGuide && discFresh ? `发现 ${discFresh} 个可接入的 CLI，点这里配置` : '扫描本机 ACP CLI，添加或编辑 provider',
                onClick: toggleDisc,
              },
                h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true },
                  h('path', { d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }), h('circle', { cx: 15, cy: 7, r: 2 }), h('circle', { cx: 9, cy: 17, r: 2 })),
                '配置 CLI',
                discFresh ? h('span', { className: 'n', title: `${discFresh} 个可添加` }, discFresh) : null),
              discGuide ? h('span', { className: 'acp-guide', 'aria-hidden': true }) : null,
              discCoach ? h('div', { className: 'acp-coach', role: 'status' },
                h('button', { type: 'button', className: 'body', onClick: toggleDisc },
                  h('span', { className: 'spark', 'aria-hidden': true }, '✦'),
                  h('span', null,
                    h('b', null, discFresh ? `发现 ${discFresh} 个可接入的 CLI` : '还没配置过本机 ACP CLI？'),
                    h('small', null, discFresh ? '点这里查看，按推荐配置一键添加' : '点这里扫描本机，添加或编辑 provider')))) : null),
            h('button', { type: 'button', className: `acp-btn${compactMode ? ' on' : ''}`, title: '紧凑模式：更小的间距与字号', onClick: () => setCompactMode(!compactMode) }, '紧凑'),
            h('button', { type: 'button', className: 'acp-btn', title: '生成当前范围的 Markdown 用量报告', onClick: () => { setCopied(false); setReport(weeklyReport({ usage, prev: data?.prev, rangeLabel, modelOf, nameOf, filter, providers })) } }, '一键报告'),
            h('button', { type: 'button', className: `acp-btn${auto ? ' on' : ''}`, onClick: () => setAuto(!auto), title: '每 15 秒刷新一次' }, auto ? '● 自动刷新' : '○ 自动刷新'),
            h('button', { type: 'button', className: 'acp-btn', disabled: loading, onClick: load }, loading ? '刷新中…' : '刷新'),
            h('a', { className: 'acp-btn', href: `${R.csv}?${query()}`, download: '', title: filterOn ? '导出当前范围 + 当前筛选的明细' : '导出当前范围的明细' }, '导出 CSV'),
            filterOn ? h('a', { className: 'acp-btn', href: `${R.csv}?${customValid ? `range=0&from=${fromMs}&to=${toMs}` : `range=${encodeURIComponent(range)}`}`, download: '' }, '导出全部') : null)),
        !lockSession ? h('div', { className: 'acp-entries' },
          h('span', { className: 'acp-tt-l' }, '入口'),
          h('label', { title: '在左侧一级侧边栏显示「ACP 洞察」页' },
            h('input', { type: 'checkbox', checked: !!entries.page, onChange: () => savePrefs({ entries: { ...entries, page: !entries.page } }) }), '侧边栏洞察页'),
          h('label', { title: '在输入框注册 /acp 命令，弹出本会话用量' },
            h('input', { type: 'checkbox', checked: !!entries.slash, onChange: () => savePrefs({ entries: { ...entries, slash: !entries.slash } }) }), '/acp 命令'),
          h('label', { title: '输入框的模型选择列表里，每个渠道用不同颜色区分，渠道名放大加粗（对所有渠道生效，不只 ACP）' },
            h('input', { type: 'checkbox', checked: !!entries.pickerColor, onChange: () => savePrefs({ entries: { ...entries, pickerColor: !entries.pickerColor } }) }), '模型列表按渠道着色')) : null,
        hostStale ? h('div', { className: 'acp-alert', style: { borderColor: 'color-mix(in srgb,var(--acp-warn) 45%,transparent)', background: 'color-mix(in srgb,var(--acp-warn) 6%,var(--acp-card))', color: 'var(--acp-warn)' } },
          '自定义区间 / 交叉筛选 / 环比需要更新后的宿主：请重启一次 DSH 生效。当前展示的是未应用这些选项的数据。') : null,
        err ? h('div', { className: 'acp-alert', role: 'alert' }, err, data ? null : h('div', { className: 'acp-note' }, '确认插件已加载最新版并重启过 DSH；接口 /api/llm-acp.dashboard 由宿主半侧注册。')) : null,
        !data && !err ? h(Skeleton) : null,
        data ? h(Fragment, null,
          filterOn ? h('div', { className: `acp-filterbar${hostFilterOk ? '' : ' warn'}` },
            h('span', null, '交叉筛选'),
            h('span', { className: 'chip', title: [filter.provider, filter.model, filter.session].filter(Boolean).join(' / ') }, filterLabel || '…'),
            h('span', { style: { color: 'var(--acp-muted)' } }, '全页卡片只统计它'),
            h('button', { type: 'button', className: 'acp-btn', style: { marginLeft: 'auto' }, onClick: () => setFilter({}) }, '清除筛选')) : null,
          h('div', { className: 'acp-kpis' },
            h(Kpi, { label: '接入 CLI', value: `${enabled}`, unit: `/ ${providers.length}`, sub: `${healthy} 个正常${enabled - healthy > 0 ? ` · ${enabled - healthy} 个需关注` : ''}`, color: '#8b5cf6' },
              h('div', { className: 'acp-dots' }, ...providers.map((p) => h('span', { key: p.id, title: p.statusText }, h('i', { style: { background: p.enabled ? colorOf(p.id) : 'var(--acp-b2)' } }), short(p.displayName))))),
            h(Kpi, { label: '可用模型', value: `${modelsOn}`, unit: `/ ${modelsAll}`, sub: modelsAll - modelsOn ? `已停用 ${modelsAll - modelsOn} 个` : '全部启用', color: '#0ea5e9' },
              h('div', { className: 'acp-meter', style: { '--pc': '#0ea5e9', marginTop: 10 } }, h('i', { style: { width: `${modelsAll ? (modelsOn / modelsAll) * 100 : 0}%` } }))),
            h(Kpi, { label: `轮次 · ${rangeLabel}`, value: n0(t.turns), sub: `失败 ${n0(t.failed)} · 中断 ${n0(t.aborted)} · 进程 ${live}/${warm}`, color: num(t.turns) ? sColor : '#10b981',
              ring: num(t.turns) ? h(Ring, { value: success, label: `${success}%`, color: sColor }) : null },
              multi ? h(Spark, { values: days.map((d) => num(d.turns)), color: '#10b981' }) : null),
            h(Kpi, { label: '输入 Token', value: compact(t.inputTokens), sub: num(t.cacheReadTokens) ? `缓存读 ${compact(t.cacheReadTokens)}` : `平均 ${compact(num(t.inputTokens) / Math.max(1, num(t.turns)))} / 轮`, color: C_IN },
              multi ? h(Spark, { values: days.map((d) => num(d.inputTokens)), color: C_IN }) : null),
            h(Kpi, { label: '输出 Token', value: compact(t.outputTokens), sub: `平均 ${compact(num(t.outputTokens) / Math.max(1, num(t.turns)))} / 轮`, color: C_OUT },
              multi ? h(Spark, { values: days.map((d) => num(d.outputTokens)), color: C_OUT }) : null),
            h(Kpi, { label: '平均耗时', value: num(t.turns) ? dur(num(t.ms) / num(t.turns)) : '-', sub: `P50 ${dur(usage.latency?.p50)} · P90 ${dur(usage.latency?.p90)}`, color: C_TIME },
              multi ? h(Spark, { values: days.map((d) => (d.turns ? num(d.ms) / d.turns : 0)), color: C_TIME }) : null)),
          data?.prev ? (() => {
            const pv = data.prev.total ?? {}
            const item = (label, cur, old, tone) => {
              const x = num(cur), y = num(old)
              if (!y) return h('span', { key: label }, label, ' ', h('b', null, x ? '新增' : '持平'))
              const d = Math.round(((x - y) / y) * 100)
              const cls = d === 0 || tone === 'neutral' ? '' : (d > 0) === (tone === 'goodUp') ? 'up' : 'dn'
              return h('span', { key: label }, label, ' ', h('b', { className: cls }, `${d > 0 ? '+' : ''}${d}%`))
            }
            return h('div', { className: 'acp-cmp' },
              h('span', null, `环比上期 · 等长 ${data.prev.byDay?.length ?? 0} 天`),
              item('轮次', t.turns, pv.turns, 'neutral'),
              item('Token', tokOf(t), tokOf(pv), 'neutral'),
              item('成功率', pctN(t.ok, t.turns), pctN(pv.ok, pv.turns), 'goodUp'),
              item('平均耗时', num(t.turns) ? num(t.ms) / num(t.turns) : 0, num(pv.turns) ? num(pv.ms) / num(pv.turns) : 0, 'goodDown'))
          })() : null,
          h(QualityStrip, { usage, modelOf }),

          h('div', { className: 'acp-grid' },
            multi ? h(DailyTrendCard, { days, recent: usage.recent, colorOf, nameOf, modelOf, type: chartType, dim: chartDim, onType: setChartType, onDim: setChartDim, prevValues, onDayClick: openDrill, drillPanel, card: fold('trend') })
              : h(Card, { className: 's8', title: '今日时段分布', ...fold('trend') }, h(HourChart, { hours: usage.hours ?? [], tall: true })),
            h(Card, { className: 's4', title: '提供方占比', sub: '按 Token · 点击筛选', ...fold('share') },
              share.some((s) => s.value > 0) ? h(Donut, { items: share, center: compact(tokOf(t)), sub: 'Token 合计', onPick: pickProvider }) : h(Empty, { text: '暂无用量' }))),

          h('div', { className: 'acp-grid' },
            h(Card, { className: 's5', title: '模型排行', sub: '按 Token · Top 8 · 点击筛选', ...fold('rank') },
              usage.byModel.length ? h(Rank, { rows: usage.byModel, colorOf, nameOf, modelOf, onPick: pickModel, active: filter.model ? `${filter.provider}/${filter.model}` : '' }) : h(Empty, { text: '暂无调用' })),
            h(HeatmapCard, { cells: data.activity ?? [], metric: heatMetric, onMetric: setHeatMetric, card: fold('heat') }),
            h(Card, { className: 's3 m6', title: '时段分布', sub: rangeLabel, ...fold('hour') }, h(HourChart, { hours: usage.hours ?? [] }))),

          h('div', { className: 'acp-grid' },
            h(LatencyCard, { usage, colorOf, nameOf, modelOf, card: fold('latency') }),
            h(CacheCard, { usage, modelOf, card: fold('cache') }),
            h(CreditCard, { providers, byModel: usage.byModel, colorOf, nameOf, modelOf, card: fold('credit') }),
            h(ThroughputCard, { usage, modelOf, card: fold('throughput') }),
            h(TpsCard, { query: filterQuery(), reloadKey: data.generatedAt, ttft: usage.ttft, modelOf, card: fold('tps') })),

          h('div', { className: 'acp-grid' },
            h(DurationCard, { usage, colorOf, nameOf, card: fold('dur') }),
            h(ProjectCard, { usage, card: fold('proj') }),
            h(DepthCard, { usage, card: fold('depth') })),

          discShown ? h('div', { ref: discRef, style: { scrollMarginTop: 12 } },
            h(DiscoverCard, { providers, autoScan: true, canSave, onEditor: setEditor, onClose: providers.length ? () => setDiscOpen(false) : undefined })) : null,
          h('div', { className: 'acp-section' }, 'CLI / ACP 提供方', h('small', null, `${enabled} 个启用 · 「管理模型」里可以开关单个模型`)),
          h('div', { className: 'acp-provs' }, ...providers.map((p) => h(ProviderCard, {
            key: p.id, p, color: colorOf(p.id), usage, days, busy, act,
            onEdit: canSave && !lockSession ? () => setEditor({ mode: 'edit', id: p.id, spec: editSpecOf(p), title: short(p.displayName), efforts: p.runtime?.efforts }) : undefined,
            onRemove: canSave && !lockSession ? () => removeProv(p) : undefined,
            open: open[p.id] === true, setOpen: (v) => setOpenMap((o) => ({ ...o, [p.id]: v })),
          }))),

          inflight.length ? h(Card, { title: `进行中 · ${inflight.length}`, sub: '点击行查看该会话的独立统计' },
            h('div', { className: 'acp-scroll' }, h('table', { className: 'acp-table' },
              h('thead', null, h('tr', null,
                ...['开始时间', '提供方', '模型', '已运行', '超时', '会话'].map((x) => h('th', { key: x }, x)),
                h('th', { key: 'go', className: 'num' }, '统计'))),
              h('tbody', null, ...inflight.map((f) => {
                const k = flightKey(f)
                const on = selFlight === k
                const toggle = () => setSelFlight(on ? '' : k)
                return h('tr', {
                  key: k, className: `click${on ? ' sel' : ''}`, tabIndex: 0, role: 'button',
                  'aria-expanded': String(on), title: on ? '点击收起该会话统计' : '点击查看该会话的独立统计',
                  onClick: toggle, onKeyDown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle() } },
                },
                  h('td', null, fmtTime(f.startedAt)),
                  h('td', null, h(Prov, { color: colorOf(f.provider), name: f.name })),
                  h('td', { title: `${f.provider}/${f.model}` }, modelOf(f.provider, f.model)),
                  h('td', null, h(Chip, { kind: 'warn' }, dur(Date.now() - f.startedAt))),
                  h('td', null, h(TimeoutCell, { f, p: provOf(f.provider) })),
                  h('td', { title: sessTitle(f.session, f.cwd) }, sessText(f.session, f.cwd)),
                  h('td', { className: 'acp-go' }, h('button', { type: 'button', onClick: (e) => { e.stopPropagation(); toggle() } }, on ? '收起 ‹' : '查看 ›')))
              })))),
            selF ? h(SessionStats, { f: selF, recent: usage.recent, colorOf, nameOf, rangeLabel, provider: provOf(selF.provider), modelOf, sessInfo }) : null) : null,

          h('div', { className: 'acp-section' }, '用量明细', h('small', null, rangeLabel)),
          h('div', { className: 'acp-grid' },
            h(SessionDistCard, { usage, colorOf, nameOf, modelOf, sessText, sessTitle, metric: sdMetric, group: sdGroup, view: sdView, onMetric: setSdMetric, onGroup: setSdGroup, onView: setSdView, filter, onPickCell: pickSessKey, onPickSession: pickSession, onPickKey: pickKey, card: fold('sessdist') })),
          h('div', { className: 'acp-grid' },
            h(ErrorClassCard, { usage, card: fold('errclass') })),
          h('div', { className: 'acp-grid' },
            h(QuotaCard, { providers, colorOf, nameOf, card: fold('quota'), busy: busy === 'quota', onRefresh: refreshQuota })),
          h('div', { className: 'acp-grid' },
            h(Card, { className: usage.errors.length ? 's7' : 's12', title: '按模型', sub: '点击行筛选全页', ...fold('bymodel') },
              usage.byModel.length ? h('div', { className: 'acp-scroll' }, h('table', { className: 'acp-table' },
                h('thead', null, h('tr', null, ...['模型', '轮次', '成功率', '输入', '输出', '平均耗时', '最近'].map((x, i) => h('th', { key: x, className: i >= 1 && i <= 5 ? 'num' : undefined }, x)))),
                h('tbody', null, ...usage.byModel.map((m) => {
                  const s = pctN(m.ok, m.turns)
                  const active = filter.provider === m.provider && filter.model === m.model
                  return h('tr', { key: `${m.provider}/${m.model}`, className: `click${active ? ' sel' : ''}`, title: active ? '点击取消筛选' : '点击让全页只看这个模型', onClick: () => pickModel(m.provider, m.model) },
                    h('td', { title: `${m.provider}/${m.model}` }, h(Prov, { color: colorOf(m.provider), name: nameOf(m.provider), model: modelOf(m.provider, m.model) })),
                    h('td', { className: 'num' }, n0(m.turns)),
                    h('td', { className: 'num' }, h(Chip, { kind: s >= 90 ? 'ok' : s >= 60 ? 'warn' : 'fail' }, pct(m.ok, m.turns))),
                    h('td', { className: 'num' }, `${compact(m.inputTokens)}${star(m)}`),
                    h('td', { className: 'num' }, `${compact(m.outputTokens)}${star(m)}`),
                    h('td', { className: 'num' }, dur(m.ms / Math.max(1, m.turns))),
                    h('td', null, ago(m.lastAt)))
                })))) : h(Empty, { text: '所选范围内还没有调用记录' })),
            h(ErrorCard, { usage, nameOf, modelOf, card: fold('errors') })),

          h(Card, { title: '最近调用', sub: usage.recent.length ? `最近 ${usage.recent.length} 条 · 点会话看统计` : '', ...fold('recent') },
            usage.recent.length ? h(Fragment, null,
              h('div', { className: 'acp-tbar' },
                h('div', { className: 'acp-seg', role: 'tablist', 'aria-label': '按结果筛选' }, ...[['all', '全部'], ['ok', '成功'], ['failed', '失败'], ['aborted', '中断']].map(([v, label]) => h('button', { key: v, type: 'button', role: 'tab', 'aria-selected': tbl.result === v, className: tbl.result === v ? 'on' : '', onClick: () => setTbl((c) => ({ ...c, result: v })) }, label))),
                h('select', { value: tbl.model, 'aria-label': '按模型筛选', onChange: (e) => setTbl((c) => ({ ...c, model: e.target.value })) },
                  h('option', { value: '' }, '全部模型'),
                  ...recentModels.map((k) => h('option', { key: k, value: k }, `${nameOf(providerOfKey(k))} / ${modelOf(providerOfKey(k), modelName(k))}`))),
                h('input', { type: 'search', placeholder: '搜索会话 / 项目…', 'aria-label': '搜索会话', value: tbl.q, onChange: (e) => setTbl((c) => ({ ...c, q: e.target.value })) }),
                h('span', { className: 'acp-note', style: { margin: 0 } }, `${recentRows.length} / ${usage.recent.length} 条`)),
              h('div', { className: 'acp-scroll' }, h('table', { className: 'acp-table' },
                h('thead', null, h('tr', null, ...['时间', '提供方', '模型', '结果', '耗时', '输入', '输出', '会话'].map((x, i) => {
                  const sk = { 0: 'at', 4: 'ms', 5: 'inputTokens', 6: 'outputTokens' }[i]
                  return h('th', { key: x, className: `${i >= 4 && i <= 6 ? 'num' : ''}${sk ? ' sort' : ''}`.trim() || undefined, title: sk ? '点击排序' : undefined, onClick: sk ? () => setTbl((c) => ({ ...c, sort: sk, dir: c.sort === sk ? -c.dir : -1 })) : undefined },
                    x, sk && tbl.sort === sk ? (tbl.dir < 0 ? ' ▼' : ' ▲') : '')
                }))),
                h('tbody', null, ...recentRows.slice(0, recentN).map((r, i) => h('tr', { key: `${r.at}-${i}` },
                  h('td', null, fmtTime(r.at)),
                  h('td', null, h(Prov, { color: colorOf(r.provider), name: nameOf(r.provider) })),
                  h('td', { title: `${r.provider}/${r.model ?? 'default'}` }, modelOf(r.provider, r.model ?? 'default')),
                  h('td', null, h(ResultChip, { r })),
                  h('td', { className: 'num' }, dur(r.ms)),
                  h('td', { className: 'num' }, `${compact(r.inputTokens)}${star(r)}`),
                  h('td', { className: 'num' }, `${compact(r.outputTokens)}${star(r)}`),
                  h('td', { style: { color: 'var(--acp-muted)' }, title: sessTitle(r.session, r.cwd) },
                    r.session ? h('button', { type: 'button', className: 'acp-link', title: '点击查看该会话统计', onClick: () => setSelSession(selSession === r.session ? '' : r.session) }, sessText(r.session, r.cwd)) : sessText(r.session, r.cwd))))))),
              recentRows.length > recentN ? h('div', { style: { textAlign: 'center', marginTop: 8 } }, h('button', { type: 'button', className: 'acp-btn', onClick: () => setRecentN(recentN + 30) }, `显示更多 · 还有 ${recentRows.length - recentN} 条`)) : null,
              selSessRec ? h(SessionStats, { f: { session: selSession, provider: selSessRec.provider, model: selSessRec.model, cwd: selSessRec.cwd, startedAt: selSessRec.at, done: true }, recent: usage.recent, colorOf, nameOf, rangeLabel, provider: provOf(selSessRec.provider), modelOf, sessInfo, onFilterSession: (sid) => setFilter({ session: sid }) }) : null)
              : h(Empty, { text: '暂无调用记录' })),

          h('div', { className: 'acp-foot' }, `dsh-llm-acp v${data.version} · 进程 ${data.pid} · 用量 ${data.files?.usage ?? '-'} · 开关 ${data.files?.prefs ?? '-'}`),
          editor ? h(ProviderEditor, { init: editor, defaults: data?.defaults, takenIds: providers.map((p) => p.id), onClose: () => setEditor(null), onSaved }) : null,
          toast ? h('div', { className: 'acp-toast', role: 'status' }, toast) : null,
          report !== null ? h('div', { className: 'acp-modal', onClick: () => setReport(null) },
            h('div', { className: 'acp-modal-box', onClick: (e) => e.stopPropagation() },
              h('div', { className: 'acp-ct' }, h('span', null, '用量报告 · Markdown'), h('span', { className: 'sub' }, rangeLabel)),
              h('textarea', { readOnly: true, value: report, 'aria-label': '报告内容', spellCheck: false }),
              h('div', { className: 'acp-tools', style: { marginTop: 10 } },
                h('button', {
                  type: 'button', className: 'acp-btn primary', onClick: () => {
                    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 2000) }
                    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) navigator.clipboard.writeText(report).then(done, () => { })
                    else if (typeof document !== 'undefined') { const ta = document.querySelector('.acp-modal-box textarea'); ta?.select?.(); try { document.execCommand('copy'); done() } catch { /* manual copy */ } }
                  },
                }, copied ? '已复制 ✓' : '复制全文'),
                h('button', { type: 'button', className: 'acp-btn', onClick: () => downloadBlob(new Blob([report], { type: 'text/markdown;charset=utf-8' }), `acp-report-${dateStr(Date.now())}.md`) }, '下载 .md'),
                h('button', { type: 'button', className: 'acp-btn', onClick: () => setReport(null) }, '关闭')))) : null) : null)
    }

    function Title() { return h('span', null, zh.title) }
    function Icon(props) {
      return h('svg', { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', ...props },
        h('rect', { x: 3, y: 4, width: 18, height: 14, rx: 2 }),
        h('path', { d: 'M7 9l3 2.5L7 14' }),
        h('path', { d: 'M12 14h5' }),
        h('path', { d: 'M8 21h8' }))
    }

    // ── entries: first-level「ACP 洞察」page + /acp command (dsh-llm-quick parity) ─────────
    let CTX = null // client plugin context, set in apply(); services are read lazily and optionally
    const svc = (name) => { try { return CTX?.get?.(name) } catch { return undefined } }
    const openConsoleTab = () => {
      const sr = svc('sidebarRight')
      if (!sr || typeof sr.openTab !== 'function') return false
      try { sr.openTab(KIND); return true } catch { return false }
    }

    // /acp: which session's modal is open ('' = none), and the typed token to consume on close.
    const modalStore = createStore('')
    const pendingSlash = new Map()
    const consumeSlash = (sid) => {
      const guard = pendingSlash.get(sid)
      pendingSlash.delete(sid)
      if (!guard) return
      try {
        const sc = svc('sessions')?.scope?.(sid)
        if (sc && typeof sc.bail === 'function') sc.bail(sc, 'slash/input-consume-token', { guard })
      } catch {}
    }
    const slashSource = () => ({
      trigger: '/', name: SLASH, order: 3,
      candidates: (_s, n) => {
        if (n?.position !== 'leading') return Promise.resolve([])
        const q = String(n?.query ?? '').trim().toLowerCase()
        if (q !== '' && !SLASH.startsWith(q)) return Promise.resolve([])
        return Promise.resolve([{ name: SLASH, label: 'acp', icon: Icon, section: 'ACP', description: '本会话 ACP 用量：提供方、模型、Token 与最近调用' }])
      },
      onPick: (e) => {
        const sid = e?.session?.sessionId
        if (!sid) return undefined
        pendingSlash.set(sid, { kind: 'span', span: e.span })
        modalStore.set(sid)
        return 'handled'
      },
      matchEnter: (s, text) => {
        if (text !== `/${SLASH}` || !s?.sessionId) return Promise.resolve(undefined)
        pendingSlash.set(s.sessionId, { kind: 'bare-token', token: `/${SLASH}` })
        modalStore.set(s.sessionId)
        return Promise.resolve('handled')
      },
    })
    /** Register `make()`'s disposers while pred(entries) holds; follow entry toggles live. */
    function gate(pred, make) {
      let live = null
      const off = () => { if (!live) return; for (const d of live.splice(0)) { try { d() } catch {} } live = null }
      const sync = () => {
        let on = false
        try { on = !!pred(entryStore.get()) } catch {}
        if (on && !live) {
          live = []
          try { for (const d of make() || []) if (typeof d === 'function') live.push(d) }
          catch (e) { console.warn('llm-acp: entry registration failed', e) }
        } else if (!on && live) off()
      }
      sync()
      const unsub = entryStore.subscribe(sync)
      return () => { unsub(); off() }
    }

    // ── model picker tint: colour every provider group in DSH's composer model list ──────────
    // DSH's ModelSelect renders each provider as <section data-menu-group> with a
    // [data-menu-group-heading] and wraps every model label in <span data-provider-id data-model-id>.
    // We only add attributes + a CSS variable to those nodes (no component replacement, and the
    // single-owner `conversation.input.model.label` slot stays free for other plugins).
    const PICK_PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#84cc16', '#f43f5e', '#14b8a6', '#f97316', '#a855f7', '#06b6d4']
    const PICK_KEY = 'dsh-llm-acp.pickerColors.v1'
    let pickMap = null
    /** Stable, collision-free colour per provider id: first-seen order, persisted in localStorage. */
    function pickColorOf(id) {
      if (!pickMap) { try { pickMap = (typeof localStorage !== 'undefined' && JSON.parse(localStorage.getItem(PICK_KEY))) || {} } catch { pickMap = {} } }
      if (!Object.prototype.hasOwnProperty.call(pickMap, id)) {
        const used = new Set(Object.values(pickMap))
        let i = 0
        while (used.has(i) && i < PICK_PALETTE.length) i++
        pickMap[id] = i < PICK_PALETTE.length ? i : Object.keys(pickMap).length % PICK_PALETTE.length
        try { localStorage.setItem(PICK_KEY, JSON.stringify(pickMap)) } catch { /* storage unavailable */ }
      }
      return PICK_PALETTE[num(pickMap[id]) % PICK_PALETTE.length]
    }
    const PICK_CSS = `
section[data-menu-group][data-acp-pc]>[data-menu-group-heading]{font-size:15px;line-height:22px;font-weight:700;letter-spacing:.01em;color:color-mix(in srgb,var(--acp-pc) 80%,var(--dsw-alias-label-primary,#1f2328))}
section[data-menu-group][data-acp-pc]>[data-menu-group-heading]::before{content:"";display:inline-block;width:4px;height:16px;border-radius:2px;margin-right:7px;vertical-align:-3px;background:var(--acp-pc)}
span[data-provider-id][data-model-id][data-acp-pc]::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px;background:var(--acp-pc)}
section[data-menu-group][data-acp-pc] button[role="menuitemradio"][data-highlighted]:not(:disabled){background:color-mix(in srgb,var(--acp-pc) 12%,transparent)}
`
    function paintPicker(root) {
      const mark = (el, c) => { if (el.getAttribute('data-acp-pc') !== c) { el.setAttribute('data-acp-pc', c); el.style.setProperty('--acp-pc', c) } }
      // Sections first, in menu order, so first-seen colours follow the picker's provider order.
      for (const sec of root.querySelectorAll('section[data-menu-group]')) {
        const lab = sec.querySelector('[data-provider-id][data-model-id]')
        if (lab) mark(sec, pickColorOf(lab.getAttribute('data-provider-id')))
      }
      for (const el of root.querySelectorAll('span[data-provider-id][data-model-id]')) mark(el, pickColorOf(el.getAttribute('data-provider-id')))
    }
    /** Install the tint (style + observer); returns its disposer. */
    function installPickerTint() {
      if (typeof document === 'undefined' || !document.body || typeof MutationObserver === 'undefined') return () => {}
      const st = document.createElement('style')
      st.setAttribute('data-llm-acp', 'picker-tint')
      st.textContent = PICK_CSS
      document.head.appendChild(st)
      let raf = 0
      const run = () => { raf = 0; try { paintPicker(document.body) } catch { /* ignore */ } }
      const mo = new MutationObserver((recs) => {
        if (raf) return
        if (!recs.some((r) => r.type === 'attributes' || r.addedNodes.length > 0)) return
        raf = requestAnimationFrame(run)
      })
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-provider-id'] })
      run()
      return () => {
        mo.disconnect()
        if (raf) cancelAnimationFrame(raf)
        st.remove()
        for (const el of document.querySelectorAll('[data-acp-pc]')) { el.removeAttribute('data-acp-pc'); el.style.removeProperty('--acp-pc') }
      }
    }

    function InsightsPage() { return h(Console, { mode: 'page' }) }
    function PanelListIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h(Icon, { width: size, height: size })
    }
    function AcpOverlay(props) {
      const sid = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const open = useStore(modalStore)
      if (!sid || open !== sid) return null
      return h(AcpModal, { sessionId: sid })
    }
    function AcpModal({ sessionId }) {
      const close = () => { modalStore.set(''); consumeSlash(sessionId) }
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') close() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [sessionId])
      return h('div', { className: 'acp-modal', onClick: close },
        h('div', { className: 'acp-modal-box acp-sessionbox', role: 'dialog', 'aria-label': '/acp', onClick: (e) => e?.stopPropagation?.() },
          h('style', null, CSS),
          h('div', { className: 'acp-ct' },
            h('span', null, `/acp · ${sess(sessionId)}`),
            h('span', { className: 'sub' }, '本会话 ACP 用量 · 范围默认全部历史'),
            h('button', { type: 'button', className: 'acp-btn', onClick: close }, '关闭 Esc')),
          h(Console, { mode: 'session', lockSession: sessionId }),
          h('div', { className: 'acp-tools', style: { marginTop: 10 } },
            h('button', { type: 'button', className: 'acp-btn primary', onClick: () => { openConsoleTab(); close() } }, '在右侧栏打开 ACP 控制台'),
            h('span', { className: 'acp-sp' }),
            h('span', { style: { color: 'var(--acp-muted)', fontSize: 11 } }, '提供方 / 模型开关仍是全局操作'))))
    }

    return {
      name: 'dsh-llm-acp-client',
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      // Exposed for the render test only; the host never reads them.
      Console, seriesFor, recentModelDays, recentEstimatedDays, TrendChart, DailyTrendCard,
      flightKey, sessionRecords, summarizeSession, sessionModels, SessionStats,
      quantile, latencyView, cacheView, errorView, creditView, qualityView, timeoutView, throughputView, errorClass,
      LatencyCard, CacheCard, CreditCard, ThroughputCard, QualityStrip, HeatmapCard, ErrorCard, ErrorClassCard, QuotaCard, quotaView, TimeoutCell, Heatmap,
      weeklyReport, dayDrill, sessionDistView, SessionDistCard,
      InsightsPage, AcpOverlay, AcpModal, slashSource,
      apply(ctx) {
        CTX = ctx
        ctx.effect(() => () => { if (CTX === ctx) CTX = null }, 'llm-acp: context handle')
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-acp: locale')
        const slotInject = (name, meta, Component) => {
          try { return ctx.slots.inject(name, () => ctx.slots.register({ name, locale: NS, ...meta }, Component)) }
          catch (e) { console.warn(`llm-acp: slot ${name} unavailable`, e); return undefined }
        }
        // ① first-level sidebar page「ACP 洞察」(same pair dsh-llm-quick uses: main + sidebar.panellist)
        ctx.effect(() => gate((e) => e.page, () => [
          slotInject('main', { key: PAGE_KEY }, InsightsPage),
          slotInject('sidebar.panellist', { id: PAGE_KEY, order: 26, label: () => 'ACP 洞察' }, PanelListIcon),
        ]), 'llm-acp: insights page')
        // ② /acp: the modal lives in the input overlay; the command is an inputTriggers source.
        ctx.effect(() => gate((e) => e.slash, () => {
          const out = [slotInject('conversation.input.overlay', { id: 'llm-acp-modal', order: 21 }, AcpOverlay)]
          if (typeof ctx.inject === 'function') {
            const fork = ctx.inject(['inputTriggers'], (scope) => {
              const it = scope.get?.('inputTriggers') ?? scope.inputTriggers
              if (it && typeof it.registerSource === 'function') scope.effect(() => it.registerSource(slashSource()), 'llm-acp: /acp command')
            })
            out.push(() => { try { fork?.dispose?.() } catch {} })
          }
          out.push(() => { const open = modalStore.get(); if (open) { modalStore.set(''); consumeSlash(open) } })
          return out
        }), 'llm-acp: /acp')
        // ③ colour provider groups in the composer's model picker (all providers)
        ctx.effect(() => gate((e) => e.pickerColor, () => [installPickerTint()]), 'llm-acp: picker tint')
        try {
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            title: () => zh.title,
            guide: [{ id: 'open', order: 61, title: () => zh.title, description: () => zh.description, icon: Icon }],
          }), 'llm-acp: tab type')
        } catch (e) { console.warn('llm-acp: tab type unavailable', e) }
        try {
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS,
          }, Console)), 'llm-acp: tab body')
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS,
          }, Title)), 'llm-acp: tab title')
        } catch (e) { console.warn('llm-acp: tab body unavailable', e) }
      },
    }
  },
})
