/* =========================================================================
 * control.js — the Transaction Control Center.
 *
 * The Control Center adds no capability. Every number rendered here is
 * computed by the backend; the view only makes it visible.
 * that showed a tick and a decision word. This file's entire job is to make the
 * fourteen decisions the pipeline already makes visible, clickable, and
 * explainable.
 *
 * Two rules govern everything below:
 *
 *   1. This file never decides anything. It reads `state` off the server
 *      response and renders it. If a panel has no data, it says so plainly
 *      rather than inventing a plausible-looking value — a demo that shows a
 *      confident number it didn't compute is worse than one that shows a gap.
 *
 *   2. Never render a verdict without its reasons. "Policy: false" is useless
 *      to a judge. "₹2,400 exceeds the ₹2,000 ceiling you set" is the product.
 * ========================================================================= */

(function () {
  'use strict';

  // ---------------------------------------------------------------- utilities

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inr(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return '₹' + Math.round(Number(n)).toLocaleString('en-IN');
  }

  function timeOf(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleTimeString('en-IN', { hour12: false });
    } catch { return ''; }
  }

  // ---------------------------------------------------------------- state

  let current = null;        // last TransactionState received
  let selectedStage = null;  // stage id the user is inspecting
  let userPinned = false;    // has the user clicked a stage? if so, stop auto-following
  let mode = 'normal';       // 'normal' | 'control'

  // Status vocabulary — mirrors src/pipeline.js. Kept as a literal map rather
  // than imported so a server-side rename shows up as an obvious visual gap
  // instead of silently styling every stage grey.
  const STATUS_META = {
    PENDING:   { label: 'Not reached', cls: 'st-pending',   glyph: '·' },
    RUNNING:   { label: 'In progress', cls: 'st-running',   glyph: '◐' },
    PASSED:    { label: 'Passed',      cls: 'st-passed',    glyph: '✓' },
    BLOCKED:   { label: 'Blocked',     cls: 'st-blocked',   glyph: '✕' },
    FAILED:    { label: 'Failed',      cls: 'st-failed',    glyph: '!' },
    RECOVERED: { label: 'Recovered',   cls: 'st-recovered', glyph: '↺' }
  };

  function statusMeta(s) {
    return STATUS_META[s] || STATUS_META.PENDING;
  }

  // ---------------------------------------------------------------- fragments

  function kv(label, value, opts) {
    const o = opts || {};
    if (value === null || value === undefined || value === '') return '';
    return `<div class="cc-kv ${o.wide ? 'cc-kv-wide' : ''}">
      <span class="cc-kv-label">${esc(label)}</span>
      <span class="cc-kv-value ${o.mono ? 'mono' : ''} ${o.tone ? 'tone-' + o.tone : ''}">${o.raw ? value : esc(value)}</span>
    </div>`;
  }

  /**
   * A scored bar. `invert` flips the colour direction for risk, where a high
   * number is bad — rendering trust and risk with the same colour ramp is the
   * single easiest way to make a judge read one of them backwards.
   */
  function bar(score, opts) {
    const o = opts || {};
    const pct = Math.max(0, Math.min(100, Number(score) || 0));
    let tone;
    if (o.invert) tone = pct >= 60 ? 'red' : pct >= 30 ? 'amber' : 'green';
    else tone = pct >= 70 ? 'green' : pct >= 40 ? 'amber' : 'red';

    const markers = (o.markers || []).map(m =>
      `<span class="cc-bar-marker" style="left:${m.at}%"><i></i>${esc(m.label)}</span>`
    ).join('');

    return `<div class="cc-bar-wrap">
      <div class="cc-bar-head">
        <span class="cc-bar-score tone-${tone}">${pct}<small>/100</small></span>
        ${o.caption ? `<span class="cc-bar-caption">${esc(o.caption)}</span>` : ''}
      </div>
      <div class="cc-bar-track"><div class="cc-bar-fill tone-${tone}" style="width:${pct}%"></div></div>
      ${markers ? `<div class="cc-bar-markers">${markers}</div>` : ''}
      ${o.scale ? `<div class="cc-scale-note">${esc(o.scale)}</div>` : ''}
    </div>`;
  }

  function reasons(list, opts) {
    const o = opts || {};
    const arr = (list || []).filter(Boolean);
    if (!arr.length) return o.empty ? `<div class="cc-empty-line">${esc(o.empty)}</div>` : '';
    return `<ul class="cc-reasons ${o.tone ? 'cc-reasons-' + o.tone : ''}">
      ${arr.map(r => `<li>${esc(r)}</li>`).join('')}
    </ul>`;
  }

  /** A boxed aside for the "why this design" notes the panels carry. */
  function note(text, label) {
    if (!text) return '';
    return `<div class="cc-note"><span class="cc-note-label">${esc(label || 'Why this matters')}</span><p>${esc(text)}</p></div>`;
  }

  function section(title, body) {
    if (!body) return '';
    return `<div class="cc-section"><h4 class="cc-section-title">${esc(title)}</h4>${body}</div>`;
  }

  function emptyPanel(stageMeta, why) {
    return `<div class="cc-empty-panel">
      <div class="cc-empty-glyph" aria-hidden="true">${esc(stageMeta ? stageMeta.icon : '·')}</div>
      <p class="cc-empty-why">${esc(why)}</p>
    </div>`;
  }

  /** Signal table shared by trust and risk — same shape, opposite meaning. */
  function signalTable(signals, opts) {
    const o = opts || {};
    if (!signals || !signals.length) return '';
    return `<table class="cc-signals">
      <thead><tr>
        <th>Signal</th><th class="cc-num">${esc(o.deltaHeader || 'Effect')}</th><th>What it found</th>
      </tr></thead>
      <tbody>${signals.map(s => {
        const d = Number(s.delta) || 0;
        const fired = !!s.triggered;
        const sign = o.invert ? '+' : (d >= 0 ? '+' : '−');
        return `<tr class="${fired ? 'fired' : 'quiet'}">
          <td>${esc(s.label)}</td>
          <td class="cc-num ${fired ? (o.invert ? 'tone-red' : (d >= 0 ? 'tone-green' : 'tone-red')) : 'tone-mute'}">${
            fired ? sign + Math.abs(d) : '—'
          }</td>
          <td class="cc-sig-detail">${esc(s.detail)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  function permissionGrid(perms) {
    if (!perms) return '';
    const col = (title, items, tone) => `<div class="cc-perm-col cc-perm-${tone}">
      <div class="cc-perm-head">${esc(title)}</div>
      <ul>${(items || []).map(i => `<li>${esc(i)}</li>`).join('') || '<li class="cc-empty-line">—</li>'}</ul>
    </div>`;
    return `<div class="cc-perm-grid">
      ${col('Allowed', perms.allowed, 'allow')}
      ${col('Denied', perms.denied, 'deny')}
    </div>`;
  }

  // ---------------------------------------------------------------- panels
  //
  // One renderer per stage. Each receives (detail, state) where `detail` is
  // whatever src/pipeline.js `mark()` attached for that stage. Renderers must
  // tolerate a null detail: the Control Center has to be openable before a
  // transaction exists, which is exactly when a judge will first click it.

  const PANELS = {

    // ---- Stage 1: Intent
    intent(d) {
      if (!d) return emptyPanel(meta('intent'), 'Nothing parsed yet. Ask the agent to buy something and this fills in with the request as it was understood.');
      return `
        ${d.raw ? `<div class="cc-quote">“${esc(d.raw)}”</div>` : ''}
        ${section('What was extracted', `
          ${kv('Search query', d.query, { mono: true })}
          ${kv('Budget ceiling', d.budgetInr ? inr(d.budgetInr) : null)}
          ${kv('Budget floor', d.minBudgetInr ? inr(d.minBudgetInr) : null)}
          ${kv('Terms', (d.terms || []).join(', ') || null, { mono: true })}
          ${kv('Parser used', d.parser)}
        `)}
        ${section('Parse confidence', bar(d.confidencePct, {
          caption: 'confidence in the parse, not in the purchase',
          scale: d.confidenceBasis
        }))}
        ${section('What this model is allowed to do', permissionGrid(d.permissions))}
        <div class="cc-hard-limit">
          <span class="cc-hard-limit-tag">Hard limit</span>
          <p>${esc(d.hardLimit)}</p>
        </div>`;
    },

    // ---- Stage 2: Buyer Agent
    buyer_agent(d) {
      if (!d) return emptyPanel(meta('buyer_agent'), 'The buyer agent is issued an identity when a purchase begins.');
      return `
        ${section('Identity', `
          ${kv('Agent ID', d.agentId, { mono: true })}
          ${kv('Acting for', d.owner)}
          ${kv('Role', d.role)}
          ${kv('Issued', d.issuedAt ? timeOf(d.issuedAt) : null, { mono: true })}
          ${kv('Mandate version', d.mandateVersion != null ? 'v' + d.mandateVersion : null, { mono: true })}
        `)}
        ${section('Runtime permissions', permissionGrid(d.permissions))}
        ${note(d.enforcement || 'These are enforced when the agent acts, not merely declared here. An agent that attempts a denied action is stopped by the code path itself, not by a reminder in its prompt.', 'How this is enforced')}`;
    },

    // ---- Stage 3: Product Discovery
    discovery(d) {
      if (!d) return emptyPanel(meta('discovery'), 'No search has run yet.');
      const rows = (d.candidates || []).map(c => `
        <tr class="${c.selected ? 'cc-chosen' : ''}">
          <td class="cc-num">${c.rank}</td>
          <td>${esc(c.name || '—')}${c.selected ? ' <span class="cc-tag-chosen">chosen</span>' : ''}</td>
          <td>${esc(c.merchant || '—')}</td>
          <td class="cc-num mono">${inr(c.priceInr)}</td>
          <td class="cc-num">${c.matchScore != null ? c.matchScore : '—'}</td>
          <td>${c.policyDecision ? `<span class="cc-mini-pill ${c.policyDecision === 'blocked' ? 'bad' : c.policyDecision === 'human_approval_required' ? 'warn' : 'ok'}">${esc(c.policyDecision.replace(/_/g, ' '))}</span>` : '—'}</td>
        </tr>`).join('');

      return `
        ${section('Where these came from', `
          ${kv('Source', d.sourceLabel)}
          ${kv('Candidates ranked', d.candidateCount)}
        `)}
        ${rows ? section('Ranked candidates', `<table class="cc-table">
          <thead><tr><th>#</th><th>Item</th><th>Merchant</th><th class="cc-num">Price</th><th class="cc-num">Match</th><th>Policy</th></tr></thead>
          <tbody>${rows}</tbody></table>`) : ''}
        ${d.chosen ? section('Selected item', `
          ${kv('Item', d.chosen.name)}
          ${kv('Merchant', d.chosen.merchant)}
          ${kv('Category', d.chosen.category, { mono: true })}
          ${kv('List price', inr(d.chosen.listPriceInr), { mono: true })}
          ${kv('Merchant tenure', d.chosen.merchantTenureDays != null ? d.chosen.merchantTenureDays + ' days on platform' : null)}
          ${kv('GST verified', d.chosen.gstVerified === null ? null : (d.chosen.gstVerified ? 'Yes' : 'No'), { tone: d.chosen.gstVerified ? 'green' : 'red' })}
          ${kv('Origin', d.chosen.originCountry)}
        `) : ''}
        ${note(d.priceProvenance, 'Where prices come from')}`;
    },

    // ---- Stage 4: Merchant Agent
    merchant_agent(d) {
      if (!d) return emptyPanel(meta('merchant_agent'), 'No merchant agent is involved until an item is selected.');
      return `
        ${section('Identity', `
          ${kv('Agent ID', d.agentId, { mono: true })}
          ${kv('Represents', d.owner)}
          ${kv('Role', d.role)}
          ${kv('Discount floor', d.maxDiscountPct != null ? d.maxDiscountPct + '%' : null, { mono: true })}
        `)}
        ${section('Runtime permissions', permissionGrid(d.permissions))}
        <div class="cc-adversarial">
          <span class="cc-hard-limit-tag warn">Not on your side</span>
          <p>${esc(d.adversarial)}</p>
        </div>`;
    },

    // ---- Stage 5: Negotiation
    negotiation(d) {
      if (!d) return emptyPanel(meta('negotiation'), 'Negotiation runs only when a discount is requested.');
      if (!d.occurred) {
        return `<div class="cc-skipped">
          <span class="cc-skip-glyph" aria-hidden="true">—</span>
          <div><strong>Not used for this purchase.</strong><p>${esc(d.reason || 'List price accepted.')}</p></div>
        </div>`;
      }
      const saved = d.finalPriceInr != null ? (d.listPriceInr || 0) - d.finalPriceInr : null;
      const offerRows = (d.offers || []).map(o => `<tr>
        <td class="mono">${esc(o.offerId)}</td><td>${esc(o.type)}</td>
        <td class="cc-num mono">${inr(o.finalAmountInr)}</td>
        <td><span class="cc-mini-pill ${o.validation?.valid ? 'ok' : 'bad'}">${esc(o.validation?.code || '—')}</span></td>
      </tr>`).join('');
      return `
        ${d.negotiationId ? section('Agent-to-Agent commerce', `
          ${kv('Negotiation ID', d.negotiationId, { mono: true })}
          ${kv('Status', d.status, { mono: true, tone: d.status === 'DEAL_CREATED' ? 'green' : 'amber' })}
          ${kv('Buyer', d.buyerAgent?.agentId, { mono: true })}
          ${kv('Merchant', d.merchantAgent?.agentId, { mono: true })}
          ${kv('Buyer maximum', inr(d.buyerMaxInr), { mono: true })}
          ${kv('Merchant floor', inr(d.merchantFloorInr), { mono: true })}
          ${kv('Protocol rounds', d.rounds, { mono: true })}
        `) : ''}
        ${section('Outcome', `<div class="cc-price-move">
          <span class="cc-price-from">${inr(d.listPriceInr)}</span>
          <span class="cc-price-arrow" aria-hidden="true">→</span>
          <span class="cc-price-to">${inr(d.finalPriceInr)}</span>
          ${saved != null ? `<span class="cc-price-delta">saved ${inr(saved)} · ${d.discountPct}% off</span>` : '<span class="cc-price-delta">awaiting merchant offer</span>'}
        </div>`)}
        ${section('Bound enforcement', `
          ${kv('Discount agreed', d.discountPct + '%', { mono: true })}
          ${kv('Discount ceiling', d.boundPct + '%', { mono: true })}
          ${kv('Within bound', (d.discountPct <= d.boundPct) ? 'Yes' : 'No — clamped', { tone: (d.discountPct <= d.boundPct) ? 'green' : 'red' })}
        `)}
        ${Array.isArray(d.transcript) && d.transcript.length ? section('Transcript', `
          <ol class="cc-transcript">${d.transcript.map(t => `<li class="cc-turn cc-turn-${esc(t.side || 'system')}">
            <span class="cc-turn-who">${esc(t.who || t.side || '')}</span>
            <span class="cc-turn-text">${esc(t.text || '')}</span>
            ${t.priceInr != null ? `<span class="cc-turn-price mono">${inr(t.priceInr)}${t.validation ? ` · ${esc(t.validation.code)}` : ''}</span>` : ''}
          </li>`).join('')}</ol>`) : ''}
        ${offerRows ? section('Inspectable offers', `<table class="cc-table"><thead><tr><th>Offer</th><th>Type</th><th class="cc-num">Final</th><th>Validation</th></tr></thead><tbody>${offerRows}</tbody></table>`) : ''}
        ${note(d.enforcement, 'Why a lie here would not work')}`;
    },

    // ---- Stage 6: Final Deal
    deal(d) {
      if (!d) return emptyPanel(meta('deal'), 'No deal has been frozen yet.');
      return `
        ${section('Frozen snapshot', `<div class="cc-fingerprint">
          ${d.dealId ? `<span class="cc-fp-label">${esc(d.dealId)} · ${esc(d.status || 'PENDING_MANDATE_VALIDATION')}</span>` : ''}
          <span class="cc-fp-label">Deal fingerprint</span>
          <code>${esc(d.fingerprint)}</code>
          <span class="cc-fp-note">SHA-256 over the priced fields. Any change to price, item or merchant produces a different fingerprint.</span>
        </div>`)}
        ${section('Price breakdown', `<table class="cc-table cc-lines">
          <tbody>${(d.lines || []).map(l => `<tr class="${l.emphasis ? 'cc-line-total' : ''}">
            <td>${esc(l.label)}</td><td class="cc-num mono">${inr(l.valueInr)}</td></tr>`).join('')}</tbody>
        </table>`)}
        ${section('Attributes', `
          ${kv('Negotiation', d.negotiationId, { mono: true })}
          ${kv('Mandate version', d.mandateVersion != null ? 'v' + d.mandateVersion : null, { mono: true })}
          ${kv('Cross-border', d.isCrossBorder ? 'Yes' : 'No', { tone: d.isCrossBorder ? 'amber' : 'green' })}
          ${kv('Within stated budget', d.withinBudget === undefined ? null : (d.withinBudget ? 'Yes' : 'No'), { tone: d.withinBudget ? 'green' : 'red' })}
          ${kv('Approval attached', d.approved ? 'Yes' : 'Not yet', { tone: d.approved ? 'green' : 'amber' })}
          ${kv('Delivery estimate', d.deliveryEstimate && d.deliveryEstimate.label)}
        `)}
        ${d.validation ? section('Deal revalidation', (d.validation.checks || []).map(c => kv(c.id, c.ok ? 'Valid' : c.detail, { tone: c.ok ? 'green' : 'red' })).join('')) : ''}
        <div class="cc-hard-limit"><span class="cc-hard-limit-tag">Authority boundary</span><p>Accepted by agents ≠ payment authorized. MANDATE still runs trust, risk, policy, approval, and the Payment Guard.</p></div>
        ${note(d.frozen, 'Why freeze it')}`;
    },

    // ---- Stage 7: Trust  (deliberately NOT merged with risk)
    trust(d) {
      if (!d) return emptyPanel(meta('trust'), 'Trust is scored once a merchant is in the picture.');
      return `
        ${section(d.question || 'How credible is this merchant?', bar(d.score, {
          caption: String(d.decision || '').replace(/_/g, ' '),
          scale: d.scale,
          markers: [{ at: 40, label: 'step-up' }, { at: 70, label: 'proceed' }]
        }))}
        ${d.stepUpVerified ? `<div class="cc-cleared">Step-up verification cleared for this transaction.</div>` : ''}
        ${section('Signals that moved the score', signalTable(d.signals, { deltaHeader: 'Points' }))}
        ${reasons(d.reasons, { empty: 'No adverse signals.' }).length ? section('In words', reasons(d.reasons, { empty: 'No adverse signals found.' })) : ''}
        ${note(d.authority, 'What trust can and cannot do')}`;
    },

    // ---- Stage 8: Risk  (the second axis)
    risk(d) {
      if (!d) return emptyPanel(meta('risk'), 'Risk is scored once there is a priced deal to score.');
      return `
        ${section(d.question || 'How unusual is this transaction?', bar(d.score, {
          invert: true,
          caption: String(d.decision || '').replace(/_/g, ' '),
          scale: d.scale,
          markers: [{ at: 30, label: 'elevated' }, { at: 60, label: 'high' }]
        }))}
        ${section('Factors', signalTable(d.signals, { invert: true, deltaHeader: 'Risk added' }))}
        ${note(d.distinction, 'Why this is separate from trust')}
        ${note(d.authority, 'What risk can and cannot do')}`;
    },

    // ---- Stage 9: Policy  (the only thing that blocks)
    policy(d) {
      if (!d) return emptyPanel(meta('policy'), 'Your mandate is checked once there is a priced deal to check it against.');
      const checks = (d.checks || []).map(c => `
        <tr class="${c.ok === false ? 'cc-check-bad' : c.ok === true ? 'cc-check-ok' : ''}">
          <td>${esc(c.label)}</td>
          <td class="cc-num mono">${c.limitInr != null ? inr(c.limitInr) : '—'}</td>
          <td class="cc-num mono">${c.actualInr != null ? inr(c.actualInr) : esc(c.actualLabel || '—')}</td>
          <td class="cc-num">${c.ok === null || c.ok === undefined ? '—' : c.ok ? '<span class="tone-green">within</span>' : '<span class="tone-red">exceeded</span>'}</td>
        </tr>
        ${c.note ? `<tr class="cc-check-note"><td colspan="4">${esc(c.note)}</td></tr>` : ''}`).join('');

      const verdictTone = d.decision === 'blocked' ? 'bad' : d.decision === 'human_approval_required' ? 'warn' : 'ok';
      return `
        <div class="cc-verdict cc-verdict-${verdictTone}">
          <span class="cc-verdict-word">${d.decision === 'blocked' ? 'REFUSED' : d.decision === 'human_approval_required' ? 'NEEDS YOU' : 'PERMITTED'}</span>
          <span class="cc-verdict-sub">by mandate v${esc(d.mandateVersion)}</span>
        </div>
        ${section('Every rule, checked against this deal', `<table class="cc-table">
          <thead><tr><th>Rule</th><th class="cc-num">Your limit</th><th class="cc-num">This deal</th><th class="cc-num">Result</th></tr></thead>
          <tbody>${checks}</tbody></table>`)}
        ${(d.violations || []).length ? section('Violations', reasons(d.violations, { tone: 'bad' })) : ''}
        ${(d.flags || []).length ? section('Flags', reasons(d.flags, { tone: 'warn' })) : ''}
        ${note(d.authority, 'Why policy is last word')}`;
    },

    // ---- Stage 10: Approval Gate
    approval(d) {
      if (!d) return emptyPanel(meta('approval'), 'The gate runs once trust, risk and policy have all reported.');
      const toneMap = { autonomous: 'ok', step_up_required: 'warn', human_required: 'warn', blocked: 'bad' };
      return `
        <div class="cc-verdict cc-verdict-${toneMap[d.mode] || 'warn'}">
          <span class="cc-verdict-word">${esc(d.headline)}</span>
          ${d.humanActionLabel ? `<span class="cc-verdict-sub">${esc(d.humanActionLabel)}</span>` : ''}
        </div>
        ${section('The comparison it made', `<div class="cc-arith">
          <code>${esc(d.comparison && d.comparison.text)}</code>
        </div>`)}
        <p class="cc-reason-lead">${esc(d.reason)}</p>
        ${(d.triggers || []).length ? section('What removed autonomy', `<ul class="cc-triggers">
          ${d.triggers.map(t => `<li>
            <span class="cc-trigger-src">${esc(t.source)}</span>
            <span class="cc-trigger-label">${esc(t.label)}</span>
            <span class="cc-trigger-detail">${esc(t.detail)}</span>
          </li>`).join('')}
        </ul>`) : `<div class="cc-cleared">Nothing escalated this. The agent was inside every boundary you set.</div>`}`;
    },

    // ---- Stage 11: Payment Guard
    payment_guard(d) {
      if (!d) return emptyPanel(meta('payment_guard'), 'The six pre-flight checks run in the instant before the payment rail is touched. Choose a payment method to see them execute.');
      return `
        <div class="cc-guard-head ${d.passed ? 'ok' : 'bad'}">
          <span class="cc-guard-count">${d.passedCount}<small>/${d.totalCount}</small></span>
          <span class="cc-guard-word">${d.passed ? 'cleared for execution' : 'execution refused'}</span>
        </div>
        <ol class="cc-checks">
          ${(d.checks || []).map((c, i) => `<li class="cc-check cc-check-${esc(c.status)}">
            <span class="cc-check-num">${i + 1}</span>
            <span class="cc-check-glyph" aria-hidden="true">${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '–'}</span>
            <div class="cc-check-body">
              <div class="cc-check-label">${esc(c.label)}${!c.critical ? ' <span class="cc-mini-pill mute">advisory</span>' : ''}</div>
              <div class="cc-check-detail">${esc(c.detail)}</div>
            </div>
          </li>`).join('')}
        </ol>
        ${!d.passed ? `<div class="cc-blocked-banner">Stopped here. No order was created, so there is nothing to refund.</div>` : ''}`;
    },

    // ---- Stage 12: Razorpay
    razorpay(d) {
      if (!d) return emptyPanel(meta('razorpay'), 'No payment has been attempted on this transaction.');
      return `
        ${section('Rail state', `
          ${kv('State', d.stateLabel)}
          ${kv('Order ID', d.orderId, { mono: true })}
          ${kv('Payment ID', d.paymentId, { mono: true })}
          ${kv('Amount', inr(d.amountInr), { mono: true })}
          ${kv('Method', d.method)}
          ${kv('Signature verified', d.signatureVerified === null ? null : (d.signatureVerified ? 'Yes — recomputed server-side' : 'No'), { tone: d.signatureVerified ? 'green' : 'red' })}
          ${kv('Mode', d.mode === 'test' ? 'Razorpay test mode — no real money moves' : d.mode)}
        `)}
        ${note(d.signatureNote, 'Why the browser is not trusted')}`;
    },

    // ---- Stage 13: Audit
    audit(d) {
      if (!d || !d.eventCount) return emptyPanel(meta('audit'), 'The log is written as decisions happen. Nothing recorded for this transaction yet.');
      return `
        ${section('Log', `<div class="cc-audit-head">
          ${kv('Transaction', d.displayId, { mono: true })}
          ${kv('Entries', d.eventCount)}
        </div>`)}
        <ol class="cc-audit-list">
          ${(d.events || []).map(e => `<li>
            <span class="cc-audit-time mono">${timeOf(e.timestamp)}</span>
            <span class="cc-audit-step mono">${esc(e.step)}</span>
            <span class="cc-audit-stage">${esc((meta(e.stage) || {}).label || e.stage)}</span>
          </li>`).join('')}
        </ol>
        <button type="button" class="cc-btn cc-trace-btn">Show backend transaction trace</button>
        <div class="cc-note cc-trace-evidence" hidden></div>
        ${note(d.nature, 'What makes this evidence')}`;
    },

    // ---- Stage 14: Replay
    replay(d) {
      if (!d || !d.available) return emptyPanel(meta('replay'), 'Replay becomes available once there is a log to replay.');
      return `
        ${section('Available', kv('Steps recorded', d.stepCount))}
        ${note(d.note, 'What replay actually does')}
        <button type="button" class="cc-btn" id="ccReplayBtn">Replay this transaction step by step</button>`;
    }
  };

  function meta(stageId) {
    if (!current || !current.stageMeta) return null;
    return current.stageMeta.find(s => s.id === stageId) || null;
  }

  // ---------------------------------------------------------------- rendering

  function renderStatusHeader() {
    const el = $('ccStatus');
    if (!el) return;
    if (!current) {
      el.innerHTML = `<div class="cc-status cc-tone-grey"><span class="cc-status-label">Waiting for a transaction</span></div>`;
      return;
    }
    const s = current.status || {};
    const p = current.progress || { done: 0, total: 14, pct: 0 };
    el.innerHTML = `
      <div class="cc-status cc-tone-${esc(s.tone || 'grey')}">
        <div class="cc-status-main">
          <span class="cc-status-id mono">${esc(current.displayId || '—')}</span>
          <span class="cc-status-label">${esc(s.label || '')}</span>
          ${s.detail ? `<span class="cc-status-detail">${esc(s.detail)}</span>` : ''}
          ${s.protectedClaim ? `<span class="cc-status-claim">${esc(s.protectedClaim)}</span>` : ''}
        </div>
        <div class="cc-status-progress">
          <div class="cc-progress-track"><div class="cc-progress-fill" style="width:${p.pct}%"></div></div>
          <span class="cc-progress-text mono">${p.done}/${p.total} stages</span>
        </div>
      </div>`;
  }

  function renderRail() {
    const el = $('ccRail');
    if (!el) return;
    if (!current) { el.innerHTML = ''; return; }

    const haltedId = current.halted ? current.halted.stageId : null;
    let pastHalt = false;

    const html = (current.layers || []).map(layer => {
      const stages = layer.stageIds.map(id => {
        const st = current.stages[id] || { status: 'PENDING' };
        const m = meta(id) || { label: id, icon: '·' };
        const sm = statusMeta(st.status);
        const isHalt = id === haltedId;
        if (isHalt) pastHalt = true;
        // Everything after a halt is drawn as unreachable rather than merely
        // pending — the pipeline visibly stops, which is the whole point.
        const unreachable = pastHalt && !isHalt && st.status === 'PENDING';

        return `<button type="button"
            class="cc-stage ${sm.cls} ${selectedStage === id ? 'is-selected' : ''} ${isHalt ? 'is-halt' : ''} ${unreachable ? 'is-unreachable' : ''}"
            data-stage="${esc(id)}"
            aria-pressed="${selectedStage === id}"
            title="${esc(m.blurb || m.label)}">
          <span class="cc-stage-icon" aria-hidden="true">${esc(m.icon)}</span>
          <span class="cc-stage-text">
            <span class="cc-stage-label">${esc(m.label)}</span>
            <span class="cc-stage-summary">${esc(st.summary || (unreachable ? 'Never reached — pipeline stopped earlier' : sm.label))}</span>
          </span>
          <span class="cc-stage-status" aria-label="${esc(sm.label)}">${sm.glyph}</span>
        </button>
        ${isHalt ? `<div class="cc-halt-line"><span>Pipeline stopped here</span></div>` : ''}`;
      }).join('');

      return `<div class="cc-layer">
        <div class="cc-layer-head"><span class="cc-layer-name">${esc(layer.label)}</span></div>
        <div class="cc-layer-stages">${stages}</div>
      </div>`;
    }).join('');

    el.innerHTML = html;
    el.querySelectorAll('.cc-stage').forEach(btn => {
      btn.addEventListener('click', () => {
        userPinned = true;
        selectStage(btn.dataset.stage);
      });
    });
  }

  function renderPanel() {
    const el = $('ccPanel');
    if (!el) return;
    if (!current || !selectedStage) {
      el.innerHTML = `<div class="cc-panel-idle">
        <p>Pick any stage on the left to see exactly what it decided and why.</p>
      </div>`;
      return;
    }

    const m = meta(selectedStage) || { label: selectedStage, icon: '·' };
    const st = current.stages[selectedStage] || { status: 'PENDING' };
    const sm = statusMeta(st.status);
    const renderer = PANELS[selectedStage];
    let body;
    try {
      body = renderer ? renderer(st.detail, current) : emptyPanel(m, 'No panel is defined for this stage.');
    } catch (err) {
      // A rendering bug in one panel must not take down the Control Center.
      body = `<div class="cc-render-error">This panel could not be drawn: ${esc(err.message)}</div>`;
    }

    el.innerHTML = `
      <div class="cc-panel-head">
        <span class="cc-panel-icon" aria-hidden="true">${esc(m.icon)}</span>
        <div class="cc-panel-titles">
          <h3>${esc(m.label)}</h3>
          <span class="cc-panel-blurb">${esc(m.blurb || '')}</span>
        </div>
        <span class="cc-panel-status ${sm.cls}">${sm.glyph} ${esc(sm.label)}</span>
      </div>
      ${m.owner ? `<div class="cc-panel-owner">Decided by: <strong>${esc(m.owner)}</strong></div>` : ''}
      <div class="cc-panel-body">${body}</div>`;

    const replayBtn = $('ccReplayBtn');
    if (replayBtn) replayBtn.addEventListener('click', replayTransaction);
    const traceBtn = el.querySelector('.cc-trace-btn');
    if (traceBtn) traceBtn.addEventListener('click', showTransactionTrace);
  }

  /**
   * The §15 screen. Two independent verdicts side by side, with the rule that
   * resolves them stated underneath. This is the single most important frame in
   * the demo, so it is always rendered when data exists — never behind a click.
   */
  function renderContrast() {
    const el = $('ccContrast');
    if (!el) return;
    const c = current && current.contrast;
    if (!c) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;

    const side = (data, which) => `<div class="cc-split-side cc-split-${which}">
      <div class="cc-split-question">${esc(data.question)}</div>
      <div class="cc-split-verdict">${esc(data.verdict)}</div>
      ${which === 'trust' && data.score != null ? `<div class="cc-split-score">${data.score}<small>/100</small></div>` : ''}
      <div class="cc-split-nature">${esc(data.nature)}</div>
      ${reasons(data.topReasons, { empty: 'No findings on this axis.' })}
    </div>`;

    el.innerHTML = `
      <div class="cc-split cc-split-${esc(c.tone)}">
        <h3 class="cc-split-headline">${esc(c.headline)}</h3>
        <div class="cc-split-body">
          ${side(c.trust, 'trust')}
          <div class="cc-split-vs" aria-hidden="true">vs</div>
          ${side(c.policy, 'policy')}
        </div>
        <p class="cc-split-explanation">${esc(c.explanation)}</p>
        <div class="cc-split-rule">${esc(c.rule)}</div>
      </div>`;
  }

  // Compact decision centre. It is a display of the server result only:
  // Trust, Risk, and Policy remain separately inspectable in the stage rail.
  function renderDecision() {
    const el = $('ccDecision');
    if (!el) return;
    const d = current && current.decision;
    if (!d) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;

    const decisionTone = d.finalDecision === 'BLOCK' ? 'block'
      : d.finalDecision === 'REVIEW' ? 'review' : 'allow';
    const engine = (label, result, type) => {
      const score = result && result.score != null ? `${esc(result.score)}/100` : 'rule check';
      const level = result?.level || result?.canonicalDecision || '—';
      return `<div class="cc-decision-engine cc-decision-${type}">
        <span class="cc-decision-engine-name">${esc(label)}</span>
        <strong>${esc(result?.canonicalDecision || '—')}</strong>
        <span>${esc(level)} · ${score}</span>
      </div>`;
    };

    el.innerHTML = `<div class="cc-decision-card cc-decision-${decisionTone}">
      <div class="cc-decision-head">
        <div><span class="cc-decision-kicker">deterministic decision</span><h3>One transaction decision</h3></div>
        <span class="cc-decision-verdict">${esc(d.finalDecision)}</span>
      </div>
      <div class="cc-decision-grid">
        ${engine('Trust', d.trust, 'trust')}
        ${engine('Risk', d.risk, 'risk')}
        ${engine('Policy', d.policy, 'policy')}
      </div>
      <p class="cc-decision-reason"><strong>${esc(d.reason || '—')}</strong> — ${esc(d.rule || '')}</p>
    </div>`;
  }

  /**
   * The nav badge. When the pipeline stops, the interesting thing is on a
   * surface the judge may not be looking at. A dot on the CONTROL tab is the
   * least intrusive way to say "the answer moved" — auto-navigating away from
   * the chat mid-conversation would be worse than saying nothing.
   */
  function renderNavBadges() {
    const badge = document.querySelector('[data-badge="control"]');
    if (!badge) return;
    const halted = current && current.halted;
    if (!halted) { badge.hidden = true; badge.removeAttribute('data-tone'); return; }
    badge.hidden = false;
    badge.dataset.tone = halted.status === 'BLOCKED' ? 'red' : 'amber';
    badge.setAttribute('title', `${halted.stageLabel}: ${halted.summary || halted.status}`);
  }

  function render() {
    renderStatusHeader();
    renderRail();
    renderPanel();
    renderContrast();
    renderDecision();
    renderPayments();
    renderAuditSurface();
    renderSecurityTransaction();
    renderAuthorizationSurface();
    renderNavBadges();
  }

  // ---------------------------------------------------------------- surfaces
  //
  // The Payments and Audit surfaces read the same TransactionState. They exist
  // so the nav is honest — every tab shows real data.
  // Neither view invents anything the pipeline does not know.

  function renderPayments() {
    const el = $('paymentsSurfaceBody');
    if (!el) return;
    if (!current || (!current.paymentGuard && !current.razorpay)) {
      el.innerHTML = `<div class="cc-panel-idle"><p>No payment activity yet this session. Complete a purchase and the guard checks and rail state appear here.</p></div>`;
      return;
    }
    el.innerHTML = `
      <div class="cc-two-col">
        <div class="cc-card">
          <h3 class="cc-card-title">Payment Guard</h3>
          ${PANELS.payment_guard(current.paymentGuard, current)}
        </div>
        <div class="cc-card">
          <h3 class="cc-card-title">Razorpay rail</h3>
          ${PANELS.razorpay(current.razorpay, current)}
        </div>
      </div>`;
  }

  function renderAuditSurface() {
    const el = $('auditSurfaceBody');
    if (!el) return;
    if (!current || !current.audit || !current.audit.eventCount) {
      el.innerHTML = `<div class="cc-panel-idle"><p>Start a purchase in Mandate. Each real step — deal, rules, approval, guard, and payment — will be recorded here in order.</p></div>`;
      return;
    }
    const byStage = {};
    for (const e of current.audit.events) {
      (byStage[e.stage] = byStage[e.stage] || []).push(e);
    }
    el.innerHTML = `
      <div class="audit-workflow" aria-label="Audit workflow"><span>Intent</span><b>→</b><span>Deal</span><b>→</b><span>Decision</span><b>→</b><span>Approval</span><b>→</b><span>Payment / receipt</span></div>
      <div class="cc-card">
        <h3 class="cc-card-title">Audit trail — ${esc(current.audit.displayId)} <span class="cc-card-sub">${current.audit.eventCount} entries, grouped by the stage that wrote them</span></h3>
        ${(current.stageOrder || []).filter(id => byStage[id]).map(id => {
          const m = meta(id) || { label: id, icon: '·' };
          return `<div class="cc-audit-group">
            <div class="cc-audit-group-head"><span aria-hidden="true">${esc(m.icon)}</span> ${esc(m.label)}</div>
            <ol class="cc-audit-list">
              ${byStage[id].map(e => `<li>
                <span class="cc-audit-time mono">${timeOf(e.timestamp)}</span>
                <span class="cc-audit-step mono">${esc(e.step)}</span>
              </li>`).join('')}
            </ol>
          </div>`;
        }).join('')}
        ${note(current.audit.nature, 'What makes this evidence')}
      </div>`;
  }

  // Authorization is an evidence-only view of the same server-owned stages.
  // It deliberately has no controls that can grant approval or override rules.
  function renderAuthorizationSurface() {
    const el = $('businessSurfaceBody');
    if (!el) return;
    if (!current) {
      el.innerHTML = `<div class="cc-panel-idle"><p>Start a purchase in Mandate. Trust, Risk, purchase rules, and your approval will appear here as separate real decisions.</p></div>`;
      return;
    }
    const stages = [
      ['trust', 'Trust'], ['risk', 'Risk'], ['policy', 'Purchase rules'], ['approval', 'Your approval']
    ];
    const cards = stages.map(([id, label]) => {
      const stage = current.stages?.[id] || { status: 'PENDING' };
      const sm = statusMeta(stage.status);
      const reason = stage.summary || stage.detail || sm.label;
      return `<article class="authorization-card ${sm.cls}"><div><b>${sm.glyph}</b><strong>${esc(label)}</strong></div><span>${esc(sm.label)}</span><small>${esc(reason)}</small></article>`;
    }).join('');
    const decision = current.decision || current.stages?.decision;
    const decisionStatus = decision?.status || current.status?.label || 'In progress';
    el.innerHTML = `<div class="authorization-live-head"><strong>Authorization for ${esc(current.displayId || 'active transaction')}</strong><span>${esc(decisionStatus)}</span></div><div class="authorization-workflow">${cards}</div><p class="authorization-note">Evidence only: Mandate may request a purchase, but this view cannot approve, override rules, or charge a payment.</p>`;
  }

  // The Security tab is tied to the same live TransactionState as the
  // transaction rail. It never invents a passing check: each chip reflects
  // the exact server-owned stage status for the active purchase.
  function renderSecurityTransaction() {
    const el = $('securityTransaction');
    if (!el) return;
    if (!current) {
      el.innerHTML = `<div class="security-live-empty"><strong>Live purchase protection</strong><span>Start a purchase in Mandate; its real security checks will appear here.</span></div>`;
      return;
    }
    const names = [
      ['discovery', 'Catalog price'], ['trust', 'Trust'], ['risk', 'Risk'],
      ['policy', 'Purchase rules'], ['approval', 'Your approval'], ['payment_guard', 'Payment Guard']
    ];
    const chips = names.map(([id, label]) => {
      const stage = current.stages?.[id] || { status: 'PENDING' };
      const sm = statusMeta(stage.status);
      return `<span class="security-live-chip ${sm.cls}"><b>${sm.glyph}</b>${esc(label)}<small>${esc(sm.label)}</small></span>`;
    }).join('');
    el.innerHTML = `<div class="security-live-head"><strong>Live transaction ${esc(current.displayId || '')}</strong><span>${esc(current.status?.label || 'In progress')} · ${esc(current.status?.detail || 'Following the active purchase')}</span></div><div class="security-live-chips">${chips}</div>`;
  }

  // ---------------------------------------------------------------- behaviour

  function selectStage(id) {
    selectedStage = id;
    renderRail();
    renderPanel();
    const panel = $('ccPanel');
    if (panel && window.innerWidth < 900) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /**
   * Auto-follow: while the user hasn't pinned a stage, the panel tracks whatever
   * the pipeline is doing — so a judge who never clicks anything still watches
   * the interesting stage. The moment they click, we stop moving under them.
   */
  function autoFollow() {
    if (userPinned || !current) return;
    const target = (current.halted && current.halted.stageId) || current.reached || 'intent';
    selectedStage = target;
  }

  function push(state) {
    if (!state) return;
    current = state;
    autoFollow();
    render();
  }

  async function refresh(sessionId) {
    if (!sessionId) return;
    try {
      const r = await fetch('/api/state/' + encodeURIComponent(sessionId));
      const data = await r.json();
      if (data && data.state) push(data.state);
    } catch (err) {
      console.warn('[control] could not refresh state:', err.message);
    }
  }

  async function replayTransaction() {
    if (!current || !current.audit || !current.audit.events.length) return;
    const btn = $('ccReplayBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Replaying…'; }
    const events = current.audit.events;
    for (const e of events) {
      selectStage(e.stage);
      await new Promise(r => setTimeout(r, 420));
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Replay this transaction step by step'; }
  }

  async function showTransactionTrace() {
    if (!current?.transactionId) return;
    const target = document.querySelector('.cc-trace-evidence');
    const btn = document.querySelector('.cc-trace-btn');
    if (!target) return;
    if (btn) btn.disabled = true;
    try {
      const response = await fetch('/api/trace/' + encodeURIComponent(current.transactionId));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Trace unavailable');
      target.hidden = false;
      target.innerHTML = `<span class="cc-note-label">Transaction trace · ${esc(data.trace.correlationId || 'unavailable')}</span><p>${data.trace.timeline.map(event => `${esc(event.stage)} · ${esc(event.event)}`).join('<br>')}</p>`;
    } catch (error) {
      target.hidden = false;
      target.textContent = `Trace unavailable: ${error.message}`;
    } finally { if (btn) btn.disabled = false; }
  }

  // ---------------------------------------------------------------- nav

  const SURFACES = ['buy', 'control', 'security', 'payments', 'audit', 'business'];

  function showSurface(name) {
    if (!SURFACES.includes(name)) return;
    for (const s of SURFACES) {
      // `document.body.dataset.surface` records the active view. Target the
      // actual content section here, otherwise a subsequent tab click finds
      // <body> first and applies `hidden` to the entire page.
      const el = document.querySelector(`section[data-surface="${s}"]`);
      if (el) el.hidden = (s !== name);
      const tab = document.querySelector(`.nav-tab[data-goto="${s}"]`);
      if (tab) {
        tab.classList.toggle('is-active', s === name);
        tab.setAttribute('aria-selected', String(s === name));
      }
    }
    document.body.dataset.surface = name;
    if (name === 'control') {
      // Seen it. The badge is a "look here", not a persistent warning label.
      const badge = document.querySelector('[data-badge="control"]');
      if (badge) badge.hidden = true;
    }
  }

  async function setMode(next) {
    mode = next;
    document.body.dataset.uiMode = next;
    const btn = $('modeToggleBtn');
    if (btn) btn.textContent = next === 'control' ? '◉ Judge Mode' : '○ Normal Mode';
    const explainer = $('modeExplainer');
    if (explainer) explainer.textContent = next === 'control'
      ? 'Judge Mode: expands evidence, stage reasons, and technical values. It cannot approve, block, or charge anything.'
      : 'Normal Mode: compact customer view. Switch to Judge Mode for full technical evidence. This never changes a decision or payment.';
    const sid = window.MandateSession && window.MandateSession.id();
    if (!sid) return;
    try {
      await fetch('/api/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, mode: next })
      });
    } catch { /* presentation-only; a failure here must not interrupt anything */ }
  }

  function init() {
    document.body.dataset.uiMode = mode;
    document.querySelectorAll('.nav-tab[data-goto]').forEach(tab => {
      tab.addEventListener('click', () => showSurface(tab.dataset.goto));
    });
    const modeBtn = $('modeToggleBtn');
    if (modeBtn) modeBtn.addEventListener('click', () => setMode(mode === 'control' ? 'normal' : 'control'));

    const unpin = $('ccUnpinBtn');
    if (unpin) unpin.addEventListener('click', () => {
      userPinned = false;
      autoFollow();
      render();
    });

    showSurface('buy');
    render();
  }

  window.MandateControl = { push, refresh, init, showSurface, selectStage, setMode };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
