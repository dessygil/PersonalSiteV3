import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import "./article-actions.css";

const visitorKey = "des-site-reaction-visitor";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let memoryVisitor;

function visitorIdentity() {
  try {
    const saved = window.localStorage.getItem(visitorKey);
    if (uuidPattern.test(saved || "")) { memoryVisitor = saved; return saved; }
  } catch { /* Private browsing may make storage unavailable. */ }
  if (!memoryVisitor) {
    const bytes = new Uint8Array(16);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
    else bytes.forEach((_, index) => { bytes[index] = Math.floor(Math.random() * 256); });
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"));
    memoryVisitor = `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  try { window.localStorage.setItem(visitorKey, memoryVisitor); } catch { /* Keep this browser session usable without persistent storage. */ }
  return memoryVisitor;
}

function confirmedReaction(response, result) {
  if (!response.ok || !Number.isSafeInteger(result?.count) || result.count < 0 || typeof result.liked !== "boolean") throw new Error("Reaction was not confirmed.");
  return { count: result.count, liked: result.liked };
}

export default function ArticleActions({ article }) {
  const [reaction, setReaction] = useState({ count: null, liked: false });
  const [phase, setPhase] = useState("loading");
  const [reload, setReload] = useState(0);
  const [reactionMessage, setReactionMessage] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  const [manualCopy, setManualCopy] = useState(false);
  const [nativeShare, setNativeShare] = useState(false);
  const [copying, setCopying] = useState(false);
  const [sharing, setSharing] = useState(false);
  const visitor = useRef(null);
  const postRequest = useRef(null);
  const pendingIntent = useRef(null);
  const mounted = useRef(false);
  const shareInput = useRef(null);
  const endpoint = `/api/article-reactions/${encodeURIComponent(article.slug)}`;
  const localPath = `/writing/${encodeURIComponent(article.slug)}`;
  const shareUrl = typeof window === "undefined" ? localPath : new URL(localPath, window.location.origin).href;
  const questionPath = `/?article=${encodeURIComponent(article.slug)}#Contact-anchor`;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; postRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    const data = { title: article.title, url: shareUrl };
    try { setNativeShare(typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare(data))); }
    catch { setNativeShare(false); }
    setShareMessage(""); setManualCopy(false);
  }, [article.title, shareUrl]);
  useEffect(() => {
    if (manualCopy) { shareInput.current?.focus(); shareInput.current?.select(); }
  }, [manualCopy]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    visitor.current = visitorIdentity();
    setReaction({ count: null, liked: false }); setPhase("loading"); setReactionMessage("");
    (async () => {
      try {
        const response = await fetch(`${endpoint}?visitor=${encodeURIComponent(visitor.current)}`, { signal: controller.signal, credentials: "same-origin", cache: "no-store" });
        const result = confirmedReaction(response, await response.json());
        if (!cancelled) { setReaction(result); setPhase("ready"); }
      } catch {
        if (!cancelled) { setPhase("load-error"); setReactionMessage("The helpful count could not be loaded. You can try again."); }
      } finally { clearTimeout(timer); }
    })();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); const pending = postRequest.current; postRequest.current = null; pending?.abort(); };
  }, [endpoint, reload]);

  async function saveReaction(liked) {
    if (postRequest.current || !visitor.current || reaction.count === null) return;
    const controller = new AbortController();
    postRequest.current = controller;
    pendingIntent.current = liked;
    const timer = setTimeout(() => controller.abort(), 10000);
    setPhase("saving"); setReactionMessage("");
    try {
      const response = await fetch(endpoint, {
        method: "POST", credentials: "same-origin", signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ visitor: visitor.current, liked }),
      });
      const result = confirmedReaction(response, await response.json());
      if (controller.signal.aborted || result.liked !== liked) throw new Error("Reaction was not saved.");
      if (mounted.current && postRequest.current === controller && !controller.signal.aborted) {
        setReaction(result); setPhase("ready");
        setReactionMessage(result.liked ? "Marked helpful. Thank you — click again to undo." : "Your helpful mark has been removed.");
      }
    } catch {
      if (mounted.current && postRequest.current === controller) {
        setPhase("save-error"); setReactionMessage("Your update could not be confirmed. Try again to save it.");
      }
    } finally { clearTimeout(timer); if (postRequest.current === controller) postRequest.current = null; }
  }

  async function copyLink() {
    setCopying(true); setShareMessage(""); setManualCopy(false);
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(shareUrl);
      if (mounted.current) setShareMessage("Link copied.");
    } catch {
      if (mounted.current) { setManualCopy(true); setShareMessage("Copy the article link below."); }
    } finally { if (mounted.current) setCopying(false); }
  }

  async function shareArticle() {
    setSharing(true); setShareMessage("");
    try {
      await navigator.share({ title: article.title, url: shareUrl });
      if (mounted.current) setShareMessage("Share completed.");
    } catch (error) {
      if (mounted.current) setShareMessage(error?.name === "AbortError" ? "Sharing cancelled." : "Sharing was not available. You can copy the link instead.");
    } finally { if (mounted.current) setSharing(false); }
  }

  return (
    <section className="article-actions" aria-labelledby="article-actions-heading">
      <h2 id="article-actions-heading">Was this useful?</h2>
      <div className="article-reaction-row">
        <button className="article-action-button article-helpful-button" type="button" aria-pressed={reaction.liked} aria-describedby="article-helpful-count" disabled={phase === "loading" || phase === "saving" || reaction.count === null} onClick={() => saveReaction(!reaction.liked)}>
          <span aria-hidden="true">{reaction.liked ? "♥" : "♡"}</span>{phase === "saving" ? "Saving…" : reaction.liked ? "Helpful · undo" : "Helpful"}
        </button>
        <span id="article-helpful-count" className="article-helpful-count">{reaction.count === null ? phase === "loading" ? "Loading count…" : "Count unavailable" : `${reaction.count} helpful ${reaction.count === 1 ? "mark" : "marks"}`}</span>
      </div>
      <div className="article-action-feedback" role="status">{reactionMessage}</div>
      {phase === "load-error" && <button className="article-action-retry" type="button" onClick={() => setReload(value => value + 1)}>Retry loading helpful count</button>}
      {phase === "save-error" && <button className="article-action-retry" type="button" onClick={() => saveReaction(pendingIntent.current)}>Retry saving helpful mark</button>}
      <div className="article-share-row" role="group" aria-label="Share this article">
        <button className="article-action-button" type="button" disabled={copying} onClick={copyLink}>{copying ? "Copying…" : "Copy link"}</button>
        <a className="article-action-button" href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`} target="_blank" rel="noopener noreferrer">Share on LinkedIn <span aria-hidden="true">↗</span></a>
        {nativeShare && <button className="article-action-button" type="button" disabled={sharing} onClick={shareArticle}>{sharing ? "Sharing…" : "Share…"}</button>}
      </div>
      <div className="article-action-feedback" role="status">{shareMessage}</div>
      {manualCopy && <div className="article-manual-copy"><label htmlFor="article-share-link">Article link</label><input id="article-share-link" ref={shareInput} readOnly value={shareUrl} onFocus={event => event.target.select()} /></div>}
      <Link className="text-link article-question-link" to={questionPath}>Ask me about this article <span aria-hidden="true">→</span></Link>
    </section>
  );
}
