"use client";

/**
 * 步行导航语音播报（src/components/nav/useWalkVoice.ts，2026-10-30 试验）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   封装浏览器内置 **Web Speech API**（`window.speechSynthesis`）：
 *   · 语音选择：优先粤语（`zh-HK` / `yue`）→ 繁中 → 简中（澳门场景以粤语为先）；
 *   · **去重节流**：同一 key（含会话 id + 步序）在 `gapMs` 内不重复朗读（GPS 高频更新不刷屏）；
 *   · **整句打断**：新播报先 `cancel()` 上一句（转向提示必须「说最新的」，不能被旧句压住）；
 *   · **开关持久化**：`localStorage`（`mmap.walkVoice`），默认开启。
 *
 * ── 关键实现要点 ──────────────────────────────────────────────────────
 *   · ⚠️ **Chrome 会把无引用的 `SpeechSynthesisUtterance` 当垃圾回收** ⇒ 播报偶发无声，
 *     故用 `utterRef` 持有当前句柄；
 *   · ⚠️ **iOS Safari 需在用户手势内先「解锁」**：`startWalkFollow`（onClick）内同步调用
 *     `unlock()`（一条 `volume=0` 的空句）；否则首个播报可能被静默吞掉；
 *   · `voices` 列表在部分浏览器**首个 tick 为空**，需监听 `voiceschanged` + 一次延时兜底；
 *   · 一切调用都在 `typeof window` 之后，SSR 阶段零副作用（`supported` 在 effect 内判定）。
 *
 * ⚠️ 纯前端（无网络请求、无密钥）：语音引擎由设备/浏览器提供，不保证一定有粤语发音人。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** 语音开关的本地存储键 */
const STORAGE_KEY = "mmap.walkVoice";

export interface WalkVoiceApi {
  /** 浏览器支持语音合成 */
  supported: boolean;
  /** 用户开关（持久化） */
  enabled: boolean;
  /** 切换开关（关 ⇒ 立即打断当前播报） */
  toggle: () => void;
  /** 用户手势内调用：解锁 iOS 的语音队列 */
  unlock: () => void;
  /** 朗读一句（`key` 用于去重，`gapMs` 内同 key 不再读） */
  speak: (key: string, text: string, gapMs?: number) => void;
  /** 打断当前播报 */
  cancel: () => void;
}

/** 语音偏好（小写前缀匹配；`zh` 兜底能命中所有中文发音人） */
const LANG_PREFER = ["zh-hk", "yue", "zh-tw", "zh-cn", "zh"] as const;

/** 按偏好挑一个发音人（无中文发音人时返回 null ⇒ 交给系统默认） */
function pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  const list = synth.getVoices();
  if (!list.length) return null;
  for (const p of LANG_PREFER) {
    const hit = list.find((v) => (v.lang || "").replace("_", "-").toLowerCase().startsWith(p));
    if (hit) return hit;
  }
  return null;
}

export function useWalkVoice(): WalkVoiceApi {
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabled] = useState(true);
  /** 开关镜像（`speak` 是稳定回调，读 ref 才不会因开关变化而重建） */
  const enabledRef = useRef(true);
  /** 选中的发音人（`voiceschanged` 后可刷新） */
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  /** 各 key 上次朗读时刻（去重节流） */
  const lastRef = useRef<Map<string, number>>(new Map());
  /** 当前句柄（防 Chrome GC 导致无声） */
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);
  /** 是否已解锁（iOS 需手势内一次） */
  const unlockedRef = useRef(false);

  /** 挂载：判定支持 + 读开关 + 初始化发音人 */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance === "undefined") return;
    setSupported(true);

    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      /* 隐私模式禁用存储 ⇒ 用默认值 */
    }
    if (stored === "0") {
      enabledRef.current = false;
      setEnabled(false);
    }

    const refresh = () => {
      voiceRef.current = pickVoice(synth);
    };
    refresh();
    synth.addEventListener("voiceschanged", refresh);
    // 部分浏览器首个 voices 为空，稍后再取一次
    const t = window.setTimeout(refresh, 800);
    return () => {
      synth.removeEventListener("voiceschanged", refresh);
      window.clearTimeout(t);
    };
  }, []);

  /** 卸载兜底：停止播报（会话关闭后不留尾音） */
  useEffect(
    () => () => {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    utterRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      enabledRef.current = next;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      if (!next && typeof window !== "undefined" && window.speechSynthesis) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore */
        }
        utterRef.current = null;
      }
      return next;
    });
  }, []);

  const unlock = useCallback(() => {
    if (unlockedRef.current) return;
    if (typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance === "undefined") return;
    unlockedRef.current = true;
    try {
      const u = new SpeechSynthesisUtterance("。");
      u.volume = 0;
      u.lang = voiceRef.current?.lang ?? "zh-HK";
      synth.speak(u);
    } catch {
      /* ignore */
    }
  }, []);

  const speak = useCallback((key: string, text: string, gapMs = 6_000) => {
    if (!enabledRef.current || !text) return;
    if (typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance === "undefined") return;

    const now = Date.now();
    if (now - (lastRef.current.get(key) ?? 0) < gapMs) return;
    lastRef.current.set(key, now);

    try {
      synth.cancel();
    } catch {
      /* ignore */
    }
    const u = new SpeechSynthesisUtterance(text);
    const v = voiceRef.current ?? pickVoice(synth);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else {
      u.lang = "zh-HK";
    }
    u.rate = 0.95;
    u.pitch = 1;
    u.volume = 1;
    utterRef.current = u;
    try {
      synth.speak(u);
    } catch {
      /* ignore */
    }
  }, []);

  return useMemo(
    () => ({ supported, enabled, toggle, unlock, speak, cancel }),
    [supported, enabled, toggle, unlock, speak, cancel],
  );
}
