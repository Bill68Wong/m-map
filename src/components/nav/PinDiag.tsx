"use client";

/**
 * 起终点钉实机诊断浮层（src/components/nav/PinDiag.tsx，v3.3.0 · AC-93 / ADR-102）
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 *   用户 Android（Chrome + 微信）双环境「两钉完全不可见」，桌面正常 ⇒ 需**真机取证**定位根因
 *   （H1 外链/合成 · H2 filter · H3 未创建）。本浮层把「钉是否创建 / 尺寸 / 是否含 `<svg>` /
 *   computed style / 环境」一次性打在一屏上，供截图回填根因结论。
 *
 * ── 触发 ──────────────────────────────────────────────────────────────
 *   URL 含 `?diag=pin` 才由 `NavShell` 渲染；**生产默认不渲染**（只读观测，无副作用）。
 *
 * ── 观测钩子 ──────────────────────────────────────────────────────────
 *   根元素 `data-diag="pin"`（QA 断言 AC-93）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   全 Token 上色；无 emoji；`pointer-events: auto` 仅自身（等宽字体、可滚动、z 最高）。
 */
import { useEffect, useState } from "react";

interface PinInfo {
  found: number;
  rect: { x: number; y: number; w: number; h: number } | null;
  style: { width: string; height: string; backgroundImage: string; filter: string; display: string } | null;
  hasSvg: boolean;
  svgBBox: { w: number; h: number } | null;
}

interface Diag {
  dest: PinInfo;
  origin: PinInfo;
  dataMap: string;
  dataNavZ: string;
  viewport: { w: number; h: number; dpr: number };
  ua: string;
  ts: string;
}

/** 采集单个钉的 DOM/computed 事实 */
function pinInfo(selector: string): PinInfo {
  const nodes = document.querySelectorAll(selector);
  const el = nodes[0] as HTMLElement | undefined;
  if (!el) return { found: nodes.length, rect: null, style: null, hasSvg: false, svgBBox: null };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const svg = el.querySelector("svg") as SVGSVGElement | null;
  let svgBBox: { w: number; h: number } | null = null;
  try {
    const bb = svg?.getBBox?.();
    if (bb) svgBBox = { w: Math.round(bb.width), h: Math.round(bb.height) };
  } catch {
    /* bbox 失败不影响其余采集 */
  }
  return {
    found: nodes.length,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    style: {
      width: cs.width,
      height: cs.height,
      backgroundImage: cs.backgroundImage,
      filter: cs.filter,
      display: cs.display,
    },
    hasSvg: !!svg,
    svgBBox,
  };
}

function collect(): Diag {
  const mapEl = document.querySelector("[data-map-follow], [data-map], .nav-map");
  const canv = document.querySelector("[data-nav-z]");
  return {
    dest: pinInfo(".nav-map__destpin"),
    origin: pinInfo(".nav-map__originpin"),
    dataMap: mapEl ? Array.from(mapEl.attributes).filter((a) => a.name.startsWith("data-")).map((a) => `${a.name}=${a.value}`).join(" ") : "(none)",
    dataNavZ: canv?.getAttribute("data-nav-z") ?? "(none)",
    viewport: {
      w: typeof window !== "undefined" ? window.innerWidth : 0,
      h: typeof window !== "undefined" ? window.innerHeight : 0,
      dpr: typeof window !== "undefined" ? window.devicePixelRatio : 1,
    },
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
    ts: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  };
}

export default function PinDiag() {
  const [d, setD] = useState<Diag | null>(null);
  useEffect(() => {
    const tick = () => setD(collect());
    tick();
    const t = window.setInterval(tick, 1000); // 每秒重采（连点/拖动后可见数值变化）
    return () => window.clearInterval(t);
  }, []);

  const fmtPin = (label: string, p: PinInfo) =>
    `${label}: found=${p.found} svg=${p.hasSvg ? "Y" : "N"}` +
    `${p.svgBBox ? ` bbox=${p.svgBBox.w}×${p.svgBBox.h}` : ""}\n` +
    `  rect=${p.rect ? `${p.rect.x},${p.rect.y} ${p.rect.w}×${p.rect.h}` : "-"}\n` +
    `  w/h=${p.style?.width ?? "-"}/${p.style?.height ?? "-"} display=${p.style?.display ?? "-"}\n` +
    `  bg=${(p.style?.backgroundImage ?? "-").slice(0, 48)}\n` +
    `  filter=${(p.style?.filter ?? "-").slice(0, 48)}`;

  return (
    <div
      data-diag="pin"
      style={{
        position: "fixed",
        inset: "auto 8px 8px 8px",
        zIndex: 9999,
        maxHeight: "46vh",
        overflow: "auto",
        padding: "8px 10px",
        borderRadius: "var(--radius-card)",
        background: "var(--surface)",
        border: "var(--frame-w) solid var(--border-strong)",
        boxShadow: "var(--shadow-card, var(--shadow-sheet))",
        color: "var(--fg)",
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontSize: "11px",
        lineHeight: 1.45,
        whiteSpace: "pre-wrap",
        pointerEvents: "auto",
      }}
    >
      {d ? (
        <>
          {`[?diag=pin] ${d.ts}\n`}
          {fmtPin("DEST ", d.dest) + "\n"}
          {fmtPin("ORIG ", d.origin) + "\n"}
          {`map: ${d.dataMap}\n`}
          {`navZ: ${d.dataNavZ}\n`}
          {`vp: ${d.viewport.w}×${d.viewport.h} dpr=${d.viewport.dpr}\n`}
          {`ua: ${d.ua}`}
        </>
      ) : (
        "采集…"
      )}
    </div>
  );
}
