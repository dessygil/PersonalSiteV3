import React, { useEffect, useRef, useState } from "react";
import { getSiteConfig } from "../../lib/siteConfig";
import { trackContactSuccess } from "../../lib/siteAnalytics";
import "./contact-form.css";

const emailAddress = "desmondgilmour@gmail.com";
const emptyFields = { name: "", email: "", message: "", _gotcha: "" };

function validate(fields) {
  const errors = {};
  if (!fields.name.trim()) errors.name = "Enter your name.";
  else if (fields.name.trim().length > 100) errors.name = "Keep your name to 100 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim()) || fields.email.trim().length > 254) errors.email = "Enter a valid email address.";
  if (!fields.message.trim()) errors.message = "Add a message.";
  else if (fields.message.trim().length > 5000) errors.message = "Keep your message to 5,000 characters or fewer.";
  return errors;
}

export function emailDraft(fields) {
  const subject = `Website message from ${fields.name.trim().replace(/[\r\n]+/g, " ")}`;
  const body = `${fields.message.trim()}\n\nFrom: ${fields.name.trim()}\nReply to: ${fields.email.trim()}`;
  return `mailto:${emailAddress}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default function ContactMe({ config = getSiteConfig() }) {
  const endpoint = config?.contact?.endpoint === "/api/contact" ? "/api/contact" : null;
  const [fields, setFields] = useState(emptyFields);
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState({ type: "idle", message: "" });
  const [enhanced, setEnhanced] = useState(false);
  const form = useRef(null);
  const focusField = useRef(null);
  const activeRequest = useRef(null);
  const mounted = useRef(true);
  const sending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    setEnhanced(true);
    return () => { mounted.current = false; activeRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    if (focusField.current) {
      form.current?.elements.namedItem(focusField.current)?.focus();
      focusField.current = null;
    }
  }, [errors]);

  function updateField(event) {
    const { name, value } = event.target;
    setFields(previous => ({ ...previous, [name]: value }));
    setErrors(previous => { const next = { ...previous }; delete next[name]; return next; });
    if (status.type !== "idle") setStatus({ type: "idle", message: "" });
  }

  async function submit(event) {
    event.preventDefault();
    if (sending.current) return;
    const nextErrors = validate(fields);
    focusField.current = Object.keys(nextErrors)[0] || null;
    setErrors(nextErrors);
    if (focusField.current) {
      setStatus({ type: "invalid", message: "Please check the highlighted fields." });
      return;
    }
    if (fields._gotcha) {
      setStatus({ type: "error", message: "The form could not be submitted. Please use the email link below." });
      return;
    }
    if (!endpoint) {
      setStatus({ type: "draft", message: "Your email app should open with a draft. Review and send it there; nothing has been sent from this website." });
      try { window.location.assign(emailDraft(fields)); }
      catch { setStatus({ type: "draft", message: "Your email app could not be opened. Nothing has been sent. Your message is still here; use the email link below to get in touch." }); }
      return;
    }

    sending.current = true;
    const controller = new AbortController();
    activeRequest.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    setStatus({ type: "submitting", message: "Submitting your message…" });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        signal: controller.signal,
        body: JSON.stringify({ name: fields.name.trim(), email: fields.email.trim(), message: fields.message.trim(), _gotcha: fields._gotcha }),
      });
      const result = await response.json().catch(() => null);
      if (response.status !== 202 || result?.ok !== true) throw new Error("Receipt was not confirmed.");
      if (mounted.current) {
        setFields(emptyFields);
        setStatus({ type: "success", message: "Thanks — your message has been received." });
        try { trackContactSuccess(); } catch { /* Optional analytics cannot change a confirmed receipt. */ }
      }
    } catch {
      if (mounted.current) setStatus({ type: "error", message: timedOut
        ? "The request timed out, so receipt could not be confirmed. Your details are still here. You can try again or use the email link below."
        : "Receipt could not be confirmed. Your details are still here. Please try again or use the email link below." });
    } finally {
      clearTimeout(timer);
      sending.current = false;
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }

  const submitting = status.type === "submitting";
  return (
    <section id="Contact-anchor" className="contact-section" aria-labelledby="contact-heading">
      <p className="eyebrow">LET’S CONNECT</p>
      <h2 id="contact-heading">Start a conversation.</h2>
      <p>Have a question about my work, a project, or something I’ve written? Please feel free to reach out. I love to chat.</p>
      <form ref={form} className="contact-form" aria-label="Contact Desmond" aria-describedby="contact-form-description" action={endpoint || `mailto:${emailAddress}`} method="post" encType={endpoint ? "application/x-www-form-urlencoded" : "text/plain"} noValidate={enhanced} onSubmit={submit}>
        <p id="contact-form-description" className="contact-form-description">{endpoint ? "Your details are used to reply. All fields are required." : "This opens your email app with a draft. You’ll review and send it there. All fields are required."}</p>
        <fieldset className="contact-fields" disabled={submitting}>
          <legend className="contact-sr-only">Your contact details and message</legend>
          <div className="contact-field">
            <label htmlFor="contact-name">Name</label>
            <input id="contact-name" name="name" autoComplete="name" value={fields.name} onChange={updateField} required maxLength={100} aria-invalid={errors.name ? "true" : undefined} aria-describedby={errors.name ? "contact-name-error" : undefined} />
            {errors.name && <p id="contact-name-error" className="contact-field-error">{errors.name}</p>}
          </div>
          <div className="contact-field">
            <label htmlFor="contact-email">Email</label>
            <input id="contact-email" type="email" name="email" autoComplete="email" value={fields.email} onChange={updateField} required maxLength={254} aria-invalid={errors.email ? "true" : undefined} aria-describedby={errors.email ? "contact-email-error" : undefined} />
            {errors.email && <p id="contact-email-error" className="contact-field-error">{errors.email}</p>}
          </div>
          <div className="contact-field contact-message-field">
            <label htmlFor="contact-message">Message</label>
            <textarea id="contact-message" name="message" rows={6} value={fields.message} onChange={updateField} required maxLength={5000} aria-invalid={errors.message ? "true" : undefined} aria-describedby={errors.message ? "contact-message-error" : undefined} />
            {errors.message && <p id="contact-message-error" className="contact-field-error">{errors.message}</p>}
          </div>
          <div className="contact-honeypot" aria-hidden="true">
            <label htmlFor="contact-gotcha">Leave this field empty</label>
            <input id="contact-gotcha" name="_gotcha" autoComplete="off" tabIndex={-1} value={fields._gotcha} onChange={updateField} />
          </div>
        </fieldset>
        <div className="contact-submit-row"><button className="primary-link" type="submit" disabled={submitting}>{submitting ? "Submitting…" : endpoint ? "Send message" : "Open email draft"}<span aria-hidden="true">↗</span></button></div>
        {status.message && <p className={`contact-form-status contact-status-${status.type}`} role={["error", "invalid"].includes(status.type) ? "alert" : "status"}>{status.message}</p>}
      </form>
      <div className="contact-direct-links"><a className="text-link" href={`mailto:${emailAddress}`}>Email me <span aria-hidden="true">↗</span></a><a className="text-link" href="https://www.linkedin.com/in/desmondgilmour">Connect on LinkedIn <span aria-hidden="true">↗</span></a></div>
    </section>
  );
}
