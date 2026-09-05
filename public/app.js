// Keep one local browser session across refreshes and tabs. Earlier builds
// generated a new id on every page load, which made a completed Razorpay TEST
// payment look absent when the user opened Audit in another tab.
const SESSION_KEY = 'paymandate.local-session.v1';
let sessionId;
try {
  sessionId = window.localStorage.getItem(SESSION_KEY) || '';
  if (!/^demo-[a-z0-9]+$/.test(sessionId)) {
    sessionId = 'demo-' + Math.random().toString(36).slice(2, 10);
    window.localStorage.setItem(SESSION_KEY, sessionId);
  }
} catch {
  // Privacy-restricted browsers still work; they simply receive one fresh
  // in-memory session for the current tab.
  sessionId = 'demo-' + Math.random().toString(36).slice(2, 10);
}

// The one place the session id is published. control.js needs it to fetch state
// and post the UI mode, and reaching across into another file's `const` is the
// kind of coupling that breaks silently the first time either file is reordered.
window.MandateSession = { id: () => sessionId };

const attackModeBtn = document.getElementById('attackModeBtn');
const attackPanel = document.getElementById('attackPanel');
const closeAttackPanelBtn = document.getElementById('closeAttackPanelBtn');
const attackLog = document.getElementById('attackLog');

const chatScroll = document.getElementById('chatScroll');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const trailBtn = document.getElementById('trailBtn');
const chainList = document.getElementById('chainList');
const mobileStrip = document.getElementById('mobileStrip');
const transactionsList = document.getElementById('transactionsList');
const commerceBrief = document.getElementById('commerceBrief');
const controlShell = document.getElementById('controlShell');
const inspectBtn = document.getElementById('inspectBtn');
const backToChatBtn = document.getElementById('backToChatBtn');

const addressModalBackdrop = document.getElementById('addressModalBackdrop');
const addressMapEl = document.getElementById('addressMap');
const addressHint = document.getElementById('addressHint');
const addressSearchInput = document.getElementById('addressSearchInput');
const addressLine = document.getElementById('addressLine');
const addressPincode = document.getElementById('addressPincode');
const confirmAddressBtn = document.getElementById('confirmAddressBtn');
const closeAddressModalBtn = document.getElementById('closeAddressModalBtn');
const useMyLocationBtn = document.getElementById('useMyLocationBtn');

const ADDRESS_MAP_STAGES = ['onboarding_address_map', 'awaiting_recipient_address_map', 'editing_address_map'];
const DEFAULT_MAP_CENTER = [12.2958, 76.6394]; // Mysuru, India
let leafletMap = null;
let addressMarker = null;
let pickedLatLng = null;

const STAGES = ['intent', 'cart', 'trust', 'approval', 'payment', 'audit'];
let lastTransactionId = null;
let currentRules = null;
let lastCommerceEvidence = null;

// Home opens directly into an empty, fresh shopping conversation.
chatInput.focus();

function openInspect(surface = 'control') {
  controlShell.hidden = false;
  if (window.MandateControl) {
    window.MandateControl.showSurface(surface);
    window.MandateControl.refresh(sessionId);
  }
}
function closeInspect() {
  controlShell.hidden = true;
  if (window.MandateControl) window.MandateControl.showSurface('buy');
}
inspectBtn.addEventListener('click', () => openInspect());
backToChatBtn.addEventListener('click', closeInspect);

// Build mobile stamp strip mirroring the desktop chain
STAGES.forEach(stage => {
  const el = document.createElement('div');
  el.className = 'mobile-stamp';
  el.dataset.stage = stage;
  el.dataset.status = 'pending';
  el.innerHTML = `<span class="dot"></span><span>${stage}</span>`;
  mobileStrip.appendChild(el);
});

function addMessage(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg-${role}`;
  wrap.innerHTML = `<div class="msg-label">${role === 'agent' ? 'Mandate' : 'you'}</div><div class="msg-body">${escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</div>`;
  chatScroll.appendChild(wrap);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-agent msg-typing';
  wrap.id = 'typingIndicator';
  wrap.innerHTML = `<div class="msg-label">Mandate</div><div class="msg-body"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  chatScroll.appendChild(wrap);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function removeTyping() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const inr = amount => amount == null ? '—' : `₹${Number(amount).toLocaleString('en-IN')}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// This explanation stays in the customer conversation. It only formats the
// already-recorded Trust/Risk/Policy evidence; it neither asks an LLM nor has
// any ability to change a decision, approval, or payment state.
function decisionExplanationText(chain = {}) {
  const decision = chain.decision || {};
  const trust = decision.trust || chain.confidence || {};
  const risk = decision.risk || {};
  const policy = decision.policy || chain.policy || {};
  const cart = chain.cart;
  const firstReason = value => Array.isArray(value) && value.length ? value[0] : null;
  const humanDecision = value => String(value || 'evaluating').replaceAll('_', ' ').toLowerCase();
  const lines = ['**Why this result**'];

  if (cart?.item?.name) lines.push(`Deal: ${cart.item.name} · ${inr(cart.pricing?.totalInr)}`);
  if (trust.score != null) lines.push(`Trust: ${trust.score}/100 — ${firstReason(trust.reasons) || humanDecision(trust.decision || trust.legacyDecision)}`);
  if (risk.score != null || risk.band != null) lines.push(`Risk: ${risk.score ?? risk.band} — ${firstReason(risk.reasons) || humanDecision(risk.decision || risk.legacyDecision)}`);
  if (policy.decision) lines.push(`Purchase rules: ${humanDecision(policy.decision)}${firstReason(policy.reasons || policy.violations) ? ` — ${firstReason(policy.reasons || policy.violations)}` : ''}`);

  const finalDecision = decision.finalDecision || (policy.decision === 'BLOCK' || policy.decision === 'blocked' ? 'BLOCK' : null);
  if (finalDecision === 'BLOCK') lines.push('Result: this purchase is stopped. No payment was created.');
  else if (trust.decision === 'step_up_required' || trust.legacyDecision === 'step_up_required') lines.push('Result: confirm the one-time code, then you can decide whether to approve.');
  else lines.push('Result: you still decide. No payment is created until you explicitly approve and choose a payment method.');
  return lines.join('\n');
}

function answerWhyInChat(chain = lastCommerceEvidence) {
  addMessage('agent', decisionExplanationText(chain));
}

function purchaseJourneyMarkup(data, chain = {}) {
  const cart = chain.cart;
  const decision = chain.decision || {};
  const negotiationActive = ['negotiation_offered', 'negotiation_counter'].includes(data.stage);
  const negotiated = !!cart?.pricing?.negotiated;
  const blocked = decision.finalDecision === 'BLOCK' || data.stage === 'blocked_by_policy' || data.stage === 'blocked';
  const approvalNow = ['awaiting_approval', 'step_up_required'].includes(data.stage);
  const paid = data.stage === 'success';
  const level = (label, state, detail) => `<span class="purchase-level ${state}"><b>${state === 'done' ? '✓' : state === 'current' ? '•' : state === 'blocked' ? '×' : '—'}</b><i>${escapeHtml(label)}</i>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span>`;
  return `<div class="purchase-journey" aria-label="Purchase protection journey">
    ${level('Product', cart || negotiationActive ? 'done' : 'current')}
    ${level('Negotiation', negotiationActive ? 'current' : negotiated ? 'done' : 'optional', negotiationActive ? 'seller offer' : negotiated ? 'deal reached' : 'if needed')}
    ${level('Trust + risk', cart ? 'done' : 'next')}
    ${level('Purchase rules', blocked ? 'blocked' : cart ? 'done' : 'next')}
    ${level('Your approval', blocked ? 'next' : approvalNow ? 'current' : paid ? 'done' : 'next')}
    ${level('Payment Guard', blocked ? 'next' : paid ? 'done' : 'next')}
  </div>`;
}

function renderCommerceBrief(data) {
  const chain = data.chain || {}; lastCommerceEvidence = chain;
  const cart = chain.cart; const decision = chain.decision; const max = currentRules?.mandate?.maxTransactionInr;
  if (data.stage === 'blocked_by_policy' || decision?.finalDecision === 'BLOCK') {
    const amount = cart?.pricing?.totalInr; const excess = amount != null && max != null ? amount - max : null;
    commerceBrief.innerHTML = `<div class="commerce-brief-kicker danger">🔐 PAYMANDATE INTERVENED</div><strong>Mandate found a deal for ${inr(amount)}. Your maximum is ${inr(max)}.</strong><div class="intervention-copy">${excess != null ? `${inr(excess)} over your limit. ` : ''}Policy <b>BLOCK</b> · Payment <b>NOT EXECUTED</b></div>${purchaseJourneyMarkup(data, chain)}<button class="commerce-link" data-commerce="why">WHY WAS THIS BLOCKED?</button>`; return;
  }
  if (['negotiation_offered', 'negotiation_counter'].includes(data.stage)) {
    commerceBrief.innerHTML = `<div class="commerce-brief-kicker">🤝 SELLER NEGOTIATION</div><strong>Mandate is asking the seller for a bounded offer.</strong><div class="intervention-copy">Your limit stays fixed. A deal still goes through all purchase checks.</div>${purchaseJourneyMarkup(data, chain)}<button class="commerce-link" data-commerce="why">Why?</button>`; return;
  }
  if (!cart) return;
  const amount = cart.pricing.totalInr; const list = cart.pricing.listPriceInr;
  const trust = decision?.trust || chain.confidence; const risk = decision?.risk; const policy = decision?.policy || chain.policy;
  const allowed = policy?.decision !== 'BLOCK' && policy?.decision !== 'blocked';
  commerceBrief.innerHTML = `<div class="commerce-brief-kicker">${cart.pricing.negotiated ? '✓ DEAL REACHED' : '🛡 PAYMANDATE CHECK'}</div>
    <div class="intent-deal-grid"><section><span>YOUR REQUEST</span><strong>Within ${inr(max)}</strong><small>Purchase rule</small></section><b>↓</b><section><span>ACTUAL DEAL</span><strong>${escapeHtml(cart.item.name)}</strong><small>${inr(amount)} · ${escapeHtml(cart.item.merchant)}</small></section></div>
    ${cart.pricing.negotiated ? `<div class="deal-math">Original ${inr(list)} <b>→</b> Final ${inr(amount)} <em>You save ${inr(list - amount)}</em></div>` : ''}
    ${purchaseJourneyMarkup(data, chain)}
    <div class="decision-strip">Trust ${trust?.score ?? '—'} · Risk ${risk?.score ?? '—'} · Policy ${escapeHtml(policy?.decision || 'EVALUATING')}</div>
    ${data.stage === 'awaiting_approval' ? `<div class="approval-moment"><strong>Only you can authorize ${inr(amount)}.</strong><span>Mandate cannot approve payment or modify your purchase rules.</span><div><button class="commerce-approve" data-commerce="approve">APPROVE ${inr(amount)}</button><button class="commerce-cancel" data-commerce="cancel">CANCEL</button></div></div>` : ''}
    ${data.paymentGuard ? `<div class="guard-moment"><b>🔒 PAYMANDATE PAYMENT GUARD</b><span>${(data.paymentGuard.checks || []).map(c => `${c.ok || c.passed ? '✓' : '✕'} ${escapeHtml(c.label || c.id)}`).join(' · ')}</span><strong>${data.paymentGuard.passed ? 'READY FOR RAZORPAY TEST' : 'PAYMENT NOT EXECUTED'}</strong></div>` : ''}
    <button class="commerce-link" data-commerce="why">WHY?</button>`;
}

commerceBrief.addEventListener('click', event => {
  const action = event.target.closest('[data-commerce]')?.dataset.commerce; if (!action) return;
  if (action === 'agent') return openAgentProfile();
  if (action === 'mandate') return sendMessage('show my mandate');
  if (action === 'edit-mandate') return sendMessage('edit my mandate');
  if (action === 'approve') return sendMessage('yes'); if (action === 'cancel') return sendMessage('no');
  answerWhyInChat();
});

const agentProfileBtn = document.getElementById('agentProfileBtn');
const agentModalBackdrop = document.getElementById('agentModalBackdrop');
const agentModalBody = document.getElementById('agentModalBody');
// The profile is a Home affordance, so its dialog lives at document level even
// though the technical shell is conditionally mounted.
document.body.appendChild(agentModalBackdrop);
async function openAgentProfile() {
  agentModalBackdrop.hidden = false; agentModalBody.textContent = 'Loading agent identity…';
  try {
    const [agentResponse, mandateResponse] = await Promise.all([fetch(`/api/agents/${sessionId}`), fetch(`/api/mandate/${sessionId}`)]);
    const [{ buyerAgent }, mandateData] = await Promise.all([agentResponse.json(), mandateResponse.json()]);
    const m = mandateData.mandate;
    agentModalBody.innerHTML = `<div class="agent-contact-card"><div class="agent-contact-avatar razorpay-avatar" aria-label="Razorpay TEST payment rail"><img src="assets/razorpay-payment-mark.png" alt=""></div><h2>Mandate</h2><p>AI Shopping Agent · Razorpay TEST rail</p><span class="agent-online">● online</span><hr><p>About</p><strong>AI shopping agent protected by PayMandate.</strong><p class="agent-authority-note">Purchase authority: <strong>Protected by PayMandate</strong>. Mandate can propose a purchase, never authorize or execute it.</p></div><div class="agent-permission-grid"><section><h3>Your purchase authority</h3><ul><li>Daily maximum: ${inr(m.dailyLimitInr)}</li><li>Per-purchase maximum: ${inr(m.maxTransactionInr)}</li><li>Approval: required</li></ul></section><section><h3>Can do</h3><ul>${buyerAgent.permissions.allowed.map(p => `<li>✓ ${escapeHtml(p)}</li>`).join('')}</ul></section><section><h3>Cannot do</h3><ul>${buyerAgent.permissions.denied.map(p => `<li>✕ ${escapeHtml(p)}</li>`).join('')}<li>✕ Direct payment execution</li></ul></section></div>`;
  } catch { agentModalBody.textContent = 'Unable to load permissions. This does not grant any authority.'; }
}
agentProfileBtn.addEventListener('click', openAgentProfile);
document.getElementById('closeAgentModalBtn').addEventListener('click', () => { agentModalBackdrop.hidden = true; });
agentModalBackdrop.addEventListener('click', e => { if (e.target === agentModalBackdrop) agentModalBackdrop.hidden = true; });

function setStageStatus(stage, status) {
  const li = chainList.querySelector(`[data-stage="${stage}"]`);
  if (li) li.dataset.status = status;
  const mob = mobileStrip.querySelector(`[data-stage="${stage}"]`);
  if (mob) mob.dataset.status = status;
}

function resetChain() {
  STAGES.forEach(s => setStageStatus(s, 'pending'));
  document.getElementById('detail-intent').textContent = 'Waiting for a request';
  document.getElementById('detail-cart').textContent = '—';
  document.getElementById('detail-trust').textContent = '—';
  document.getElementById('detail-approval').textContent = '—';
  document.getElementById('detail-payment').textContent = '—';
  document.getElementById('detail-audit').textContent = '—';
  document.getElementById('scoreBarTrack').hidden = true;
  document.getElementById('signalList').hidden = true;
  document.getElementById('signalList').innerHTML = '';
}

function applyChain(chain, extra) {
  const completed = chain.completedStages || [];
  const reached = chain.reached;

  STAGES.forEach(stage => {
    if (completed.includes(stage) && stage !== reached) {
      setStageStatus(stage, 'stamped');
    }
  });

  if (reached) {
    if (reached === 'trust' && extra) {
      if (extra.confidence) renderTrust(extra.confidence, extra);
      if (extra.policy?.decision === 'blocked') setStageStatus('trust', 'blocked');
      else if (extra.confidence?.decision === 'blocked') setStageStatus('trust', 'blocked');
      else if (extra.confidence?.decision === 'step_up_required' && !extra.stepUpVerified) setStageStatus('trust', 'stepup');
      else if (extra.policy?.decision === 'human_approval_required') setStageStatus('trust', 'stepup');
      else setStageStatus('trust', 'stamped');
    } else if (reached === 'intent' || reached === 'cart') {
      setStageStatus(reached, 'active');
    } else {
      setStageStatus(reached, 'stamped');
    }

    if (extra?.cart) {
      document.getElementById('detail-intent').textContent = 'Request parsed';
      const c = extra.cart;
      document.getElementById('detail-cart').textContent =
        `${c.item.name} · ₹${c.pricing.totalInr}${c.isCrossBorder ? ' (cross-border)' : ''}`;
    }
    if (reached === 'approval' || completed.includes('approval')) {
      document.getElementById('detail-approval').textContent = 'Explicitly approved by user';
    }
    if (extra?.paymentResult) {
      document.getElementById('detail-payment').textContent = `Order ${extra.paymentResult.orderId} · ₹${extra.paymentResult.amountInr}`;
    }
    if (extra?.error) {
      document.getElementById('detail-payment').textContent = `Blocked: ${extra.error}`;
      setStageStatus('payment', 'blocked');
    }
    if (reached === 'audit') {
      document.getElementById('detail-audit').textContent = 'Full trail available';
      trailBtn.disabled = false;
    }
  }
}

function renderTrust(confidence, extra) {
  const label = extra.stepUpVerified
    ? `Step-up verified · score ${confidence.score}/100`
    : `Score ${confidence.score}/100 → ${confidence.decision.replace(/_/g, ' ')}`;
  document.getElementById('detail-trust').textContent = label;

  const track = document.getElementById('scoreBarTrack');
  const fill = document.getElementById('scoreBarFill');
  track.hidden = false;
  fill.style.width = confidence.score + '%';
  fill.style.background = confidence.decision === 'blocked' ? 'var(--red)'
    : confidence.decision === 'step_up_required' ? 'var(--amber)'
    : 'var(--green)';

  const list = document.getElementById('signalList');
  list.hidden = false;
  list.innerHTML = '';
  (confidence.signals || []).forEach(sig => {
    const li = document.createElement('li');
    if (sig.triggered) li.classList.add('triggered');
    li.innerHTML = `<span>${sig.label}</span><span class="signal-delta">${sig.delta > 0 ? '+' : ''}${sig.delta}</span>`;
    list.appendChild(li);
  });

  // Policy engine result — kept visually separate from the trust signals above,
  // since it's a different (deterministic, non-scored) system.
  const policy = extra.policy;
  if (policy && (policy.violations?.length || policy.flags?.length)) {
    const li = document.createElement('li');
    li.style.borderLeftColor = policy.decision === 'blocked' ? 'var(--red)' : 'var(--amber)';
    li.classList.add('triggered');
    const text = policy.decision === 'blocked' ? policy.violations.join('; ') : policy.flags.join('; ');
    li.innerHTML = `<span>Mandate policy</span><span class="signal-delta" style="color:${policy.decision === 'blocked' ? 'var(--red)' : 'var(--amber)'}">${policy.decision === 'blocked' ? 'BLOCKED' : 'FLAGGED'}</span>`;
    li.title = text;
    list.appendChild(li);
    const detailLi = document.createElement('li');
    detailLi.style.fontSize = '10.5px';
    detailLi.style.opacity = '0.8';
    detailLi.textContent = text;
    list.appendChild(detailLi);
  }
}

async function sendMessage(text, addressPayload, productChoice) {
  addMessage('user', text);
  if (chatInput.value) chatInput.value = '';
  sendBtn.disabled = true;
  addTyping();

  let data = null;
  try {
    const body = { sessionId, message: text };
    if (addressPayload) body.addressPayload = addressPayload;
    if (productChoice) body.productChoice = productChoice;
    const res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    data = await res.json();
    removeTyping();
    applyServerResponse(data);
  } catch (err) {
    removeTyping();
    addMessage('agent', `Connection error: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
    chatInput.focus();
  }
  return data;
}

// Shared response handling — used by sendMessage (chat) and by the Razorpay
// Checkout success/cancel handlers below, since both paths return the same
// { reply, stage, chain, ... } shape from the backend.
function applyServerResponse(data) {
  addMessage('agent', data.reply);
  renderCommerceBrief(data);

  // Every mutating response carries the whole normalized pipeline
  //     picture (see withState in src/server.js). Handing it straight to the
  //     Control Center means the six-stage sidebar and the fourteen-stage rail
  //     are reading the same snapshot, so they cannot drift apart mid-demo.
  if (data.state && window.MandateControl) {
    window.MandateControl.push(data.state);
  }

  if (data.newRequest) {
    resetChain();
    trailBtn.disabled = true;
  }

  if (data.chain) applyChain(data.chain, data.chain);

  const WHY_STAGES = ['blocked', 'blocked_by_policy', 'step_up_required', 'awaiting_approval'];
  if (WHY_STAGES.includes(data.stage) && data.chain) {
    renderWhyButton(data.chain);
  }

  if (data.stage === 'success' && data.transactionId) {
    lastTransactionId = data.transactionId;
    loadTransactions();
    loadMandate();
  }

  if (data.stage === 'mandate_updated') {
    loadMandate();
  }

  if (data.receiptUrl) {
    renderReceiptCard(data.receiptUrl, data.transactionId, data.delivery);
  }

  if (ADDRESS_MAP_STAGES.includes(data.stage)) {
    openAddressModal(data.stage);
  }

  if (data.stage === 'awaiting_budget_range') {
    renderBudgetPicker();
  }

  if (data.stage === 'product_choice' && data.products) {
    renderProductChoice(data.products);
  }

  if (data.stage === 'awaiting_delivery_choice') {
    renderSimpleChips([
      { label: 'Myself', value: 'myself' },
      { label: 'Someone else', value: 'someone else' },
      { label: 'Edit my details', value: 'edit' }
    ]);
  }

  if (data.stage === 'awaiting_payment_method') {
    renderSimpleChips([
      { label: 'Cash on Delivery', value: 'cod' },
      { label: 'Pay Online', value: 'online' }
    ]);
  }

  if (data.stage === 'awaiting_cod_confirmation') {
    renderSimpleChips([
      { label: 'Yes, place order', value: 'yes' },
      { label: 'No, cancel', value: 'no' }
    ]);
  }

  if (data.stage === 'awaiting_online_payment' && data.razorpay) {
    openRazorpayCheckout(data.razorpay);
  }

  if (data.stage === 'negotiation_offered') {
    renderSimpleChips([{ label: 'Negotiate', value: 'yes' }, { label: 'Show other options', value: 'no' }]);
  }
  if (data.stage === 'negotiation_counter') {
    renderSimpleChips([{ label: 'Accept offer', value: 'yes' }, { label: 'Counter', value: 'counter' }, { label: 'Decline', value: 'no' }]);
  }

  // "Skip" / "Keep current" chip for optional or edit-with-default steps —
  // no need to type "skip" by hand.
  const SKIP_CHIP_STAGES = {
    onboarding_email: 'Skip',
    awaiting_recipient_email: 'Skip',
    editing_name: 'Keep current',
    editing_phone: 'Keep current',
    editing_email: 'Keep current',
    editing_address_map: 'Keep current'
  };
  if (SKIP_CHIP_STAGES[data.stage]) {
    renderSimpleChips([{ label: SKIP_CHIP_STAGES[data.stage], value: 'skip' }]);
  }
}

// ---------- Razorpay Checkout (real card/UPI/netbanking widget) ----------
function openRazorpayCheckout(details) {
  let paymentFailureHandled = false;
  if (typeof Razorpay === 'undefined') {
    addMessage('agent', `Payment widget failed to load — check your internet connection and try "online" again, or use "cod".`);
    return;
  }
  const options = {
    key: details.keyId,
    amount: details.amountInr * 100, // paise
    currency: 'INR',
    name: 'paymandate',
    description: details.itemName,
    order_id: details.orderId,
    handler: async function (response) {
      addTyping();
      try {
        const res = await fetch('/api/payment/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature
          })
        });
        const data = await res.json();
        removeTyping();
        if (data.error) {
          addMessage('agent', `Payment could not be verified: ${data.error}. No order was placed — try again or choose Cash on Delivery.`);
          return;
        }
        applyServerResponse(data);
      } catch (err) {
        removeTyping();
        addMessage('agent', `Connection error while verifying payment: ${err.message}`);
      }
    },
    modal: {
      ondismiss: async function () {
        if (paymentFailureHandled) return;
        try {
          const res = await fetch('/api/payment/cancelled', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId })
          });
          const data = await res.json();
          applyServerResponse(data);
        } catch (err) {
          addMessage('agent', `Payment window closed.`);
        }
      }
    },
    theme: { color: '#C9A24B' }
  };
  const rzp = new Razorpay(options);
  rzp.on('payment.failed', async function (response) {
    if (paymentFailureHandled) return;
    paymentFailureHandled = true;
    try {
      const res = await fetch('/api/payment/cancelled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      const data = await res.json();
      data.reply = `⚠️ Payment couldn't be completed. No duplicate payment was created. ${data.reply}`;
      applyServerResponse(data);
    } catch (err) { addMessage('agent', '⚠️ Payment could not be confirmed. No duplicate order was created; choose another payment method.'); }
  });
  rzp.open();
}

// ---------- Budget quick-picks + custom range slider ----------
// ---------- Generic quick-reply chips (yourself/someone-else, COD/online, etc.) ----------
// ---------- "Why?" explainability button (for blocked/step-up/approval messages) ----------
function renderWhyButton(chain) {
  const wrap = document.createElement('div');
  wrap.className = 'quick-replies';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'quick-reply-chip';
  btn.textContent = 'Why?';
  btn.addEventListener('click', () => {
    btn.remove();
    answerWhyInChat(chain);
  });
  wrap.appendChild(btn);
  chatScroll.appendChild(wrap);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function renderSimpleChips(options) {
  const wrap = document.createElement('div');
  wrap.className = 'quick-replies';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-reply-chip';
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      wrap.remove();
      sendMessage(opt.value);
    });
    wrap.appendChild(btn);
  });
  chatScroll.appendChild(wrap);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

// ---------- Receipt card (receipt, audit evidence, delivery, return/refund) ----------
function renderReceiptCard(receiptUrl, transactionId, delivery = {}) {
  const card = document.createElement('div');
  card.className = 'budget-slider-card';
  card.classList.add('receipt-card');
  const deliveryAddress = [delivery.address, delivery.pincode].filter(Boolean).join(' · ');
  card.innerHTML = `
    <div style="font-size:13px;font-weight:600;margin-bottom:10px;">📄 Order receipt</div>
    <a href="${escapeHtml(receiptUrl)}" target="_blank" rel="noopener" class="budget-confirm-btn" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px;">View / download receipt</a>
    <a href="/api/audit/${encodeURIComponent(transactionId)}.pdf" target="_blank" rel="noopener" class="quick-reply-chip" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px;">Download audit PDF</a>
    <section class="receipt-delivery" aria-label="Delivery information">
      <span class="receipt-delivery-label">DELIVERY</span>
      <strong>${escapeHtml(delivery.estimate || 'Delivery estimate pending')}</strong>
      <span>${escapeHtml(delivery.name || 'Recipient details confirmed')}</span>
      <span>${escapeHtml(deliveryAddress || 'Delivery address confirmed')}</span>
      <span class="receipt-order-id">Order ${escapeHtml(delivery.orderId || transactionId)}</span>
    </section>
    <a href="${escapeHtml(delivery.trackingUrl || `/track/${transactionId}`)}" target="_blank" rel="noopener" class="quick-reply-chip receipt-tracking-link" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px;">Track delivery →</a>
    <button type="button" class="refund-btn" style="width:100%;padding:9px;" data-txn="${escapeHtml(transactionId)}">Return / refund order</button>
  `;
  card.querySelector('.refund-btn').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Processing…';
    try {
      const res = await fetch('/api/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, transactionId, reason: 'Requested from receipt card' })
      });
      const data = await res.json();
      if (data.refund) {
        btn.textContent = 'Refunded';
        addMessage('agent', `Return / refund processed — ₹${data.refund.amountInr} reversed (${data.refund.simulated ? 'simulated, no captured payment existed to reverse' : 'via Razorpay'}).`);
        loadTransactions();
      loadMandate();
      } else {
        btn.textContent = 'Failed — retry';
        btn.disabled = false;
      }
    } catch (err) {
      btn.textContent = 'Failed — retry';
      btn.disabled = false;
    }
  });
  chatScroll.appendChild(card);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function renderBudgetPicker() {
  const wrap = document.createElement('div');
  wrap.className = 'quick-replies';
  const presets = [
    { label: 'Under ₹500', value: 'under 500' },
    { label: '₹500 – ₹1500', value: '500 to 1500' },
    { label: '₹1500 – ₹3000', value: '1500 to 3000' },
    { label: '₹3000 – ₹5000', value: '3000 to 5000' },
    { label: 'Above ₹5000', value: '5000 to 50000' },
    { label: 'Custom range', value: '__custom__' }
  ];
  presets.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-reply-chip';
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
      wrap.remove();
      if (p.value === '__custom__') {
        renderBudgetSlider();
      } else {
        sendMessage(p.value);
      }
    });
    wrap.appendChild(btn);
  });
  chatScroll.appendChild(wrap);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function renderBudgetSlider() {
  const card = document.createElement('div');
  card.className = 'budget-slider-card';
  card.innerHTML = `
    <div class="budget-slider-values"><span id="budgetMinLabel">₹500</span><span id="budgetMaxLabel">₹3000</span></div>
    <div class="budget-slider-row">
      <input type="range" id="budgetMinRange" min="0" max="20000" step="50" value="500">
      <input type="range" id="budgetMaxRange" min="0" max="20000" step="50" value="3000">
    </div>
    <div class="budget-slider-labels"><span>₹0</span><span>₹20,000+</span></div>
    <button type="button" class="budget-confirm-btn">Confirm range</button>
  `;
  chatScroll.appendChild(card);
  chatScroll.scrollTop = chatScroll.scrollHeight;

  const minRange = card.querySelector('#budgetMinRange');
  const maxRange = card.querySelector('#budgetMaxRange');
  const minLabel = card.querySelector('#budgetMinLabel');
  const maxLabel = card.querySelector('#budgetMaxLabel');

  function sync() {
    let lo = parseInt(minRange.value, 10);
    let hi = parseInt(maxRange.value, 10);
    if (lo > hi) { [lo, hi] = [hi, lo]; }
    minLabel.textContent = `₹${lo.toLocaleString('en-IN')}`;
    maxLabel.textContent = `₹${hi.toLocaleString('en-IN')}`;
  }
  minRange.addEventListener('input', sync);
  maxRange.addEventListener('input', sync);

  card.querySelector('.budget-confirm-btn').addEventListener('click', () => {
    let lo = parseInt(minRange.value, 10);
    let hi = parseInt(maxRange.value, 10);
    if (lo > hi) { [lo, hi] = [hi, lo]; }
    card.remove();
    sendMessage(`${lo} to ${hi}`);
  });
}

// ---------- Product choice cards ----------
function starRating(rating) {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function renderProductChoice(products) {
  const wrap = document.createElement('div');
  wrap.className = 'product-list';
  products.forEach(p => {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.dataset.decision = p.decision;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    const decisionLabel = p.decision === 'proceed' ? 'high confidence'
      : p.decision === 'step_up_required' ? 'needs step-up'
      : 'blocked';

    const imageHtml = p.imageUrl
      ? `<img src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=&quot;product-card-image-placeholder&quot;>${escapeHtml(p.name.charAt(0))}</span>'">`
      : `<span class="product-card-image-placeholder">${escapeHtml(p.name.charAt(0))}</span>`;

    const ratingHtml = p.sellerRating
      ? `<div class="product-card-rating"><span class="product-card-stars">${starRating(p.sellerRating)}</span><span>${p.sellerRating.toFixed(1)}${p.sellerRatingCount ? ` (${p.sellerRatingCount.toLocaleString('en-IN')})` : ''}</span></div>`
      : '';

    const badges = [];
    if (p.source === 'live') {
      badges.push('Amazon India');
    } else {
      if (p.gstVerified) badges.push({ text: 'GST verified', cls: 'verified' });
      if (p.merchantTenureDays != null) badges.push(`${p.merchantTenureDays}d on platform`);
    }
    if (p.category) badges.push(p.category);
    if (p.policyDecision === 'human_approval_required') badges.push({ text: 'mandate: human approval', cls: '' });
    const badgesHtml = badges.length
      ? `<div class="product-card-badges">${badges.map(b => typeof b === 'string' ? `<span class="product-card-badge">${escapeHtml(b)}</span>` : `<span class="product-card-badge ${b.cls}">${escapeHtml(b.text)}</span>`).join('')}</div>`
      : '';

    card.innerHTML = `
      <div class="product-card-image">${imageHtml}</div>
      <div class="product-card-body">
        <div class="product-card-top">
          <div class="product-card-name">${escapeHtml(p.name)}</div>
          <div class="product-card-score">${p.score}</div>
        </div>
        ${ratingHtml}
        ${badgesHtml}
        <div class="product-card-meta">
          <span>${escapeHtml(p.merchant)}</span>
          <span class="product-card-price">₹${p.price.toLocaleString('en-IN')}${p.crossBorderFeeInr ? ` <span style="font-size:10px;color:var(--paper-dim)">+fee</span>` : ''}</span>
        </div>
        <div class="product-card-meta">
          <span class="product-card-source">${decisionLabel}</span>
          <button type="button" class="why-btn">Why?</button>
        </div>
        <div class="product-card-why" hidden></div>
      </div>
    `;

    const selectCard = () => {
      wrap.querySelectorAll('.product-card').forEach(c => { c.style.pointerEvents = 'none'; c.style.opacity = '0.5'; });
      sendMessage(p.name, null, p.id);
    };
    card.addEventListener('click', e => {
      if (e.target.closest('.why-btn')) return;
      selectCard();
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCard(); }
    });

    const whyBtn = card.querySelector('.why-btn');
    const whyPanel = card.querySelector('.product-card-why');
    whyBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!whyPanel.hidden) { whyPanel.hidden = true; return; }
      const lines = [];
      (p.reasons || []).forEach(r => lines.push(`• ${r}`));
      if (p.policyViolations?.length) p.policyViolations.forEach(v => lines.push(`• Mandate: ${v}`));
      if (p.policyFlags?.length) p.policyFlags.forEach(f => lines.push(`• Mandate: ${f}`));
      if (p.merchantAgent) lines.push(`• Merchant Agent ${p.merchantAgent.agentId} (${p.merchantAgent.owner}) — can negotiate & offer bundles, cannot authorize payment or modify your mandate`);
      whyPanel.innerHTML = lines.length
        ? lines.map(l => `<div>${escapeHtml(l)}</div>`).join('')
        : '<div>No risk factors triggered — clean signals across the board.</div>';
      whyPanel.hidden = false;
    });

    wrap.appendChild(card);
  });
  chatScroll.appendChild(wrap);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

// ---------- Map-based address picker ----------
let pendingAddressStage = null;

function openAddressModal(stage) {
  pendingAddressStage = stage;
  addressModalBackdrop.hidden = false;
  addressLine.value = '';
  addressPincode.value = '';
  addressSearchInput.value = '';
  addressHint.textContent = 'Click anywhere on the map, or search below.';
  confirmAddressBtn.disabled = true;
  pickedLatLng = null;

  setTimeout(() => {
    // Leaflet is a deferred third-party script and the tiles come from a CDN.
    // Neither is allowed to break address entry: if `L` never arrived, say so
    // plainly and let the user type the address, which is all the pipeline
    // actually needs. Throwing here used to take the whole modal down.
    if (typeof L === 'undefined') {
      addressMapEl.classList.add('address-map-offline');
      addressMapEl.textContent = 'Map unavailable offline — type the address below instead.';
      addressHint.textContent = 'Enter the address and pincode manually.';
      confirmAddressBtn.disabled = false;
      return;
    }
    if (!leafletMap) {
      leafletMap = L.map(addressMapEl).setView(DEFAULT_MAP_CENTER, 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
      }).addTo(leafletMap);
      leafletMap.on('click', e => placeMarker(e.latlng.lat, e.latlng.lng));
    }
    leafletMap.invalidateSize();
  }, 50);
}

async function placeMarker(lat, lng) {
  pickedLatLng = { lat, lng };
  if (leafletMap) {
    if (addressMarker) leafletMap.removeLayer(addressMarker);
    addressMarker = L.marker([lat, lng]).addTo(leafletMap);
    leafletMap.panTo([lat, lng]);
  }
  addressHint.textContent = 'Looking up this location…';

  try {
    const res = await fetch(`/api/geocode/reverse?lat=${lat}&lon=${lng}`);
    const data = await res.json();
    if (data.address) {
      addressLine.value = data.address;
      addressPincode.value = data.pincode || '';
      addressHint.textContent = 'Pin dropped — edit the details below if needed.';
      confirmAddressBtn.disabled = false;
    } else {
      addressHint.textContent = 'Could not auto-fill — please type the address manually.';
      confirmAddressBtn.disabled = false;
    }
  } catch (err) {
    addressHint.textContent = 'Lookup failed — please type the address manually.';
    confirmAddressBtn.disabled = false;
  }
}

let searchDebounce = null;
addressSearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = addressSearchInput.value.trim();
  if (q.length < 3) return;
  searchDebounce = setTimeout(async () => {
    try {
      const res = await fetch(`/api/geocode/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.results && data.results[0]) {
        const first = data.results[0];
        // No map is not an error — the search still resolves a real address, so
        // fill the fields and move on. Only the panning is map-dependent.
        if (leafletMap) leafletMap.setView([first.lat, first.lng], 15);
        placeMarker(first.lat, first.lng);
      }
    } catch (err) { /* non-fatal */ }
  }, 600);
});

useMyLocationBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    addressHint.textContent = 'Location is not available in this browser. Search, drop a pin, or enter the address below.';
    return;
  }
  addressHint.textContent = 'Requesting your location…';
  useMyLocationBtn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    position => {
      useMyLocationBtn.disabled = false;
      placeMarker(position.coords.latitude, position.coords.longitude);
    },
    () => {
      useMyLocationBtn.disabled = false;
      addressHint.textContent = 'Location permission was not granted. Search, drop a pin, or enter the address below.';
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
  );
});

confirmAddressBtn.addEventListener('click', () => {
  const address = addressLine.value.trim();
  if (!address) return;
  const pincode = addressPincode.value.trim();
  if (!/^\d{6}$/.test(pincode)) {
    addressHint.textContent = 'Please enter a valid 6-digit delivery pincode.';
    addressPincode.focus();
    return;
  }
  const payload = {
    address,
    pincode,
    lat: pickedLatLng?.lat ?? null,
    lng: pickedLatLng?.lng ?? null
  };
  addressModalBackdrop.hidden = true;
  sendMessage(address, payload);
});

closeAddressModalBtn.addEventListener('click', () => {
  addressModalBackdrop.hidden = true;
  addMessage('agent', `No problem — you can type the address in the chat instead.`);
});

chatForm.addEventListener('submit', e => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  // if starting a fresh purchase (not an OTP/approval reply mid-flow), reset the chain visual
  sendMessage(text);
});

async function loadMandate() {
  try {
    const res = await fetch(`/api/mandate/${sessionId}`);
    const data = await res.json();
    const m = data.mandate;
    currentRules = data;
    commerceBrief.innerHTML = `<div class="commerce-brief-kicker">📌 PURCHASE MANDATE</div><div class="rules-summary"><strong>Daily limit ${inr(m.dailyLimitInr)}</strong><span>Per-purchase maximum ${inr(m.maxTransactionInr)} · approval required</span></div><div class="mandate-quick-actions"><button class="commerce-link" data-commerce="mandate">View mandate</button><button class="commerce-link" data-commerce="edit-mandate">Edit mandate</button></div>`;
    const spentPct = Math.min(100, Math.round((data.spentTodayInr / m.dailyLimitInr) * 100));
    const panel = document.getElementById('mandatePanel');
    panel.innerHTML = `
      <div class="mandate-row"><span>Rules version</span><strong>v${data.mandateVersion}</strong></div>
      <div class="mandate-row"><span>Per-transaction max</span><strong>₹${m.maxTransactionInr.toLocaleString('en-IN')}</strong></div>
      <div class="mandate-row"><span>Autonomous threshold</span><strong>₹${m.autonomousSpendThresholdInr.toLocaleString('en-IN')}</strong></div>
      <div>
        <div class="mandate-row"><span>Today's spend</span><strong>₹${data.spentTodayInr.toLocaleString('en-IN')} / ₹${m.dailyLimitInr.toLocaleString('en-IN')}</strong></div>
        <div class="mandate-bar-track"><div class="mandate-bar-fill" style="width:${spentPct}%"></div></div>
      </div>
      ${m.blockedCategories.length ? `<div class="mandate-categories">Blocked: ${m.blockedCategories.join(', ')}</div>` : ''}
      <div class="mandate-categories" style="margin-top:4px;">Only you can update these rules.</div>
    `;
  } catch (err) {
    // non-fatal
  }
}
loadMandate();

async function loadTransactions() {
  try {
    const res = await fetch(`/api/transactions/${sessionId}`);
    const data = await res.json();
    transactionsList.innerHTML = '';
    if (!data.transactions || data.transactions.length === 0) {
      transactionsList.innerHTML = '<li class="transactions-empty">None yet this session</li>';
      return;
    }
    data.transactions.forEach(txn => {
      const li = document.createElement('li');
      li.className = 'transaction-item';
      li.innerHTML = `
        <div class="txn-top">
          <span>${escapeHtml(txn.item.name)}</span>
          <span class="txn-amount">₹${txn.paymentResult.amountInr}</span>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="passport-btn" data-txn="${txn.transactionId}">Passport</button>
          <button class="refund-btn" data-txn="${txn.transactionId}">Reverse / refund</button>
          <button class="replay-btn" data-txn="${txn.transactionId}">▶ Replay</button>
        </div>
      `;
      transactionsList.appendChild(li);
    });
  } catch (err) {
    // non-fatal
  }
}

// Restore completed receipts/passports after a refresh or when this is opened
// in a second tab sharing the same local browser session.
loadTransactions();

transactionsList.addEventListener('click', async e => {
  const btn = e.target.closest('.refund-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Processing…';
  try {
    const res = await fetch('/api/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, transactionId: btn.dataset.txn, reason: 'Demo reversal from console' })
    });
    const data = await res.json();
    if (data.refund) {
      addMessage('agent', `Refund processed for that order — ₹${data.refund.amountInr} reversed (${data.refund.simulated ? 'simulated, no captured payment existed to reverse' : 'via Razorpay'}). Logged to the audit trail.`);
      btn.textContent = 'Refunded';
    } else {
      btn.textContent = 'Failed — retry';
      btn.disabled = false;
    }
  } catch (err) {
    btn.textContent = 'Failed — retry';
    btn.disabled = false;
  }
});

const passportModalBackdrop = document.getElementById('passportModalBackdrop');
const passportBody = document.getElementById('passportBody');
async function openPassport(transactionId) {
  passportModalBackdrop.hidden = false; passportBody.textContent = 'Reconstructing from append-only evidence…';
  try {
    const [txResponse, traceResponse] = await Promise.all([fetch(`/api/transactions/${sessionId}`), fetch(`/api/trace/${transactionId}`)]);
    const txData = await txResponse.json(); const traceData = await traceResponse.json();
    const tx = txData.transactions.find(item => item.transactionId === transactionId); const events = traceData.trace?.timeline || [];
    const decision = [...events].reverse().find(event => event.event === 'DECISION_EVALUATED')?.details || {};
    const deal = [...events].reverse().find(event => event.event === 'FINAL_DEAL_CREATED')?.details || {};
    passportBody.innerHTML = `<div class="passport-readonly">READ ONLY · REPLAY NEVER EXECUTES A PAYMENT</div><h3>${escapeHtml(tx?.item?.name || 'Transaction')}</h3><div class="passport-grid"><span>Agent</span><strong>Mandate</strong><span>Intent</span><strong>${escapeHtml(events.find(e => e.event === 'INTENT_PARSED')?.details?.request || 'Recorded in trace')}</strong><span>Final deal</span><strong>${inr(tx?.paymentResult?.amountInr)} · ${escapeHtml(deal.dealId || 'Recorded')}</strong><span>Trust</span><strong>${escapeHtml(decision.trust?.decision || 'ALLOW')}</strong><span>Risk</span><strong>${escapeHtml(decision.risk?.decision || 'LOW')}</strong><span>Policy</span><strong>${escapeHtml(decision.policy?.decision || 'ALLOW')}</strong><span>Approval</span><strong>CONFIRMED</strong><span>Payment Guard</span><strong>PASSED</strong><span>Razorpay</span><strong>${escapeHtml(tx?.paymentResult?.status || 'RECORDED')}</strong><span>Correlation ID</span><code>${escapeHtml(traceData.trace?.correlationId || 'Recorded')}</code></div><div class="passport-actions"><button class="quick-reply-chip" id="passportWhy">WHY</button><button class="quick-reply-chip" id="passportTrace">TRACE</button><button class="quick-reply-chip" id="passportReplay">REPLAY</button></div>`;
    document.getElementById('passportWhy').addEventListener('click', () => addMessage('agent', `PAYMANDATE WHY\n${decision.finalReason || 'Decision evidence is available in the trace.'}`));
    document.getElementById('passportTrace').addEventListener('click', () => { passportModalBackdrop.hidden = true; document.querySelector(`.replay-btn[data-txn="${CSS.escape(transactionId)}"]`)?.click(); });
    document.getElementById('passportReplay').addEventListener('click', () => { passportModalBackdrop.hidden = true; document.querySelector(`.replay-btn[data-txn="${CSS.escape(transactionId)}"]`)?.click(); });
  } catch { passportBody.textContent = 'Passport evidence is unavailable; no payment action was attempted.'; }
}
transactionsList.addEventListener('click', event => { const button = event.target.closest('.passport-btn'); if (button) openPassport(button.dataset.txn); });
document.getElementById('closePassportBtn').addEventListener('click', () => { passportModalBackdrop.hidden = true; });
passportModalBackdrop.addEventListener('click', event => { if (event.target === passportModalBackdrop) passportModalBackdrop.hidden = true; });

// ---------- Audit trail modal ----------
const trailModalBackdrop = document.getElementById('trailModalBackdrop');
const trailTimeline = document.getElementById('trailTimeline');
const trailTxnId = document.getElementById('trailTxnId');

const STEP_LABELS = {
  intent_parsed: 'Intent parsed',
  item_found: 'Item found',
  no_match_found: 'No match found',
  negotiation_offered: 'Merchant Agent negotiation offered',
  negotiation_round: 'Negotiation round',
  negotiation_settled: 'Negotiation settled',
  negotiation_declined: 'Negotiation declined',
  agent_permission_check: 'Agent permission check',
  cart_shown: 'Cart mandate shown',
  blocked_over_budget: 'Blocked — over budget',
  confidence_scored: 'Confidence scored',
  catalog_source: 'Catalog source determined',
  candidates_scored: 'Candidates scored and ranked',
  item_selected: 'Item selected by user',
  step_up_triggered: 'Step-up verification triggered',
  step_up_failed: 'Step-up code incorrect',
  step_up_verified: 'Step-up verified',
  blocked_low_confidence: 'Blocked — confidence too low',
  blocked_by_policy: 'Blocked — mandate policy violation',
  cart_pending_approval: 'Awaiting user approval',
  user_approved: 'User approved cart',
  payment_executed: 'Payment executed',
  payment_blocked: 'Payment blocked',
  cod_confirmed: 'Cash on Delivery confirmed',
  razorpay_order_created: 'Razorpay order created',
  payment_captured: 'Payment captured (Razorpay Checkout)',
  payment_signature_invalid: 'Payment signature verification failed',
  payment_cancelled: 'Payment cancelled by user',
  receipt_generated: 'Receipt PDF generated',
  receipt_generation_failed: 'Receipt generation failed',
  refund_processed: 'Refund processed',
  refund_failed: 'Refund failed'
};

function buildTrailLi(entry) {
  const li = document.createElement('li');
  const time = new Date(entry.timestamp).toLocaleTimeString();
  let detail = '';
  if (entry.step === 'confidence_scored') {
    detail = `score ${entry.details.confidence.score}/100 → ${entry.details.confidence.decision}`;
  } else if (entry.step === 'cart_shown') {
    detail = `${entry.details.cart.item.name} · ₹${entry.details.cart.pricing.totalInr}`;
  } else if (entry.step === 'payment_executed') {
    detail = `order ${entry.details.orderId} · ₹${entry.details.amountInr}`;
  } else if (entry.step === 'intent_parsed') {
    detail = `"${entry.details.request}"`;
  }
  li.innerHTML = `<span class="trail-step-label">${STEP_LABELS[entry.step] || entry.step}</span><span class="trail-step-time">${time}</span>${detail ? `<div class="trail-step-detail">${escapeHtml(detail)}</div>` : ''}`;
  return li;
}

trailBtn.addEventListener('click', async () => {
  if (!lastTransactionId) return;
  const res = await fetch(`/api/trail/${lastTransactionId}`);
  const data = await res.json();
  trailTxnId.textContent = lastTransactionId;
  trailTimeline.innerHTML = '';
  data.trail.forEach(entry => trailTimeline.appendChild(buildTrailLi(entry)));
  trailModalBackdrop.hidden = false;
});

// Decision Replay — same trail data, revealed one step at a time instead of all at once.
transactionsList.addEventListener('click', async e => {
  const replayBtn = e.target.closest('.replay-btn');
  if (!replayBtn) return;
  const txnId = replayBtn.dataset.txn;
  replayBtn.disabled = true;
  replayBtn.textContent = 'Replaying…';
  try {
    const res = await fetch(`/api/trail/${txnId}`);
    const data = await res.json();
    trailTxnId.textContent = txnId + ' (replay)';
    trailTimeline.innerHTML = '';
    trailModalBackdrop.hidden = false;
    for (const entry of data.trail) {
      await new Promise(r => setTimeout(r, 550));
      const li = buildTrailLi(entry);
      li.style.animation = 'msg-in 0.3s ease-out';
      trailTimeline.appendChild(li);
      trailTimeline.scrollTop = trailTimeline.scrollHeight;
    }
  } finally {
    replayBtn.disabled = false;
    replayBtn.textContent = '▶ Replay';
  }
});

document.getElementById('closeTrailBtn').addEventListener('click', () => {
  trailModalBackdrop.hidden = true;
});
trailModalBackdrop.addEventListener('click', e => {
  if (e.target === trailModalBackdrop) trailModalBackdrop.hidden = true;
});

// ---------- Attack Mode ----------
// ---------- Dashboard ----------
// ---------- All Features overview ----------
const featuresBtn = document.getElementById('featuresBtn');
const featuresModalBackdrop = document.getElementById('featuresModalBackdrop');
const closeFeaturesBtn = document.getElementById('closeFeaturesBtn');
const featuresBody = document.getElementById('featuresBody');

const FEATURE_GROUPS = [
  {
    title: 'Trust & Policy (the core)',
    items: [
      { name: 'Trust Layer confidence scoring', desc: 'Every product gets a 0-100 score from real signals — cross-border, verification, merchant history/seller rating, category risk, spend velocity.', action: { type: 'chat', value: 'buy me basic earbuds under 2000' } },
      { name: 'Deterministic Policy Engine', desc: 'A hard, non-scored mandate check — max transaction, daily limit, autonomous-spend threshold — runs independently of trust and can block even a high-confidence purchase.', action: { type: 'chat', value: 'buy me a keyboard under 12000' } },
      { name: 'Mandate versioning', desc: 'Every mandate change creates a new version — past transactions stay tied to the version that actually authorized them. Try "set my daily limit to 30000".', action: { type: 'chat', value: 'set my daily limit to 30000' } },
      { name: 'Agent Identity & enforced permissions', desc: 'The Buyer Agent and each Merchant Agent get a stated ID and permission set (visible via a product\'s "Why?" panel) — and the negotiation discount bound is runtime-enforced in code (see Attack Mode → Agent Permission Violation), not just documented.', action: { type: 'chat', value: 'buy me basic earbuds under 2000' } },
      { name: 'Your mandate panel', desc: 'Live limits, version, and today\'s spend, always visible in the right panel.', action: null }
    ]
  },
  {
    title: 'Product discovery',
    items: [
      { name: 'Budget quick-picks / custom slider', desc: 'Tap a preset range or drag a dual-handle slider instead of typing a number.', action: { type: 'chat', value: 'buy me a phone case' } },
      { name: 'Live Amazon India search', desc: 'Real product data via RapidAPI when a key is configured — falls back to the local catalog automatically otherwise.', action: { type: 'chat', value: 'buy me earbuds under 2000' } },
      { name: 'Ranked, tappable product cards', desc: 'Every match shown at once, sorted by confidence — you choose, the agent doesn\'t pick for you.', action: { type: 'chat', value: 'buy me a phone case under 1000' } },
      { name: 'Map-based address picker', desc: 'Pin-drop address entry (Zomato/Swiggy-style) during onboarding or recipient details, with free reverse-geocoding.', action: null }
    ]
  },
  {
    title: 'Merchant AI',
    items: [
      { name: 'Merchant Agent negotiation', desc: 'When nothing fits your budget, the Merchant Agent proposes a bounded counter-offer (max 10% off) — never bypasses trust/policy checks.', action: { type: 'chat', value: 'buy me basic earbuds under 1300' } },
      { name: 'Bundle upsell offers', desc: 'A relevant add-on offered at a partial discount alongside a negotiated price.', action: null }
    ]
  },
  {
    title: 'Security — Attack Mode',
    items: [
      { name: '6 live attacks against real code', desc: 'Prompt injection, price manipulation, mandate violation, fake merchant, network failure, agent permission violation — each runs through the actual pipeline, nothing is scripted output.', action: { type: 'attack' } }
    ]
  },
  {
    title: 'Explainability',
    items: [
      { name: '"Why?" button', desc: 'On every product card and blocked/step-up/approval message — expands the real trust signals and mandate flags behind that decision.', action: { type: 'chat', value: 'buy me a keyboard under 12000' } },
      { name: 'Audit trail timeline', desc: 'Full timestamped log of every step for a completed purchase — open via "View audit trail" after checkout.', action: null },
      { name: 'Decision Replay', desc: 'On any completed order in the sidebar — "▶ Replay" plays back its full audit trail one step at a time instead of all at once.', action: null }
    ]
  },
  {
    title: 'Payments & fulfillment',
    items: [
      { name: 'Cash on Delivery or Razorpay online', desc: 'Choose your payment method right before the final approval.', action: null },
      { name: 'PDF order receipt', desc: 'Auto-generated after payment/COD — item, price breakdown, delivery estimate, all in one downloadable file.', action: null },
      { name: 'Refund / return', desc: 'One tap on any completed order, in the sidebar or on the receipt card.', action: null },
      { name: 'Payment failure recovery', desc: 'An idempotency ledger prevents a retry from ever double-charging — see it live in Attack Mode → Network Failure.', action: { type: 'attack' } }
    ]
  },
  {
    title: 'Dashboards',
    items: [
      { name: 'Buyer, Merchant, Revenue Simulator & Revenue Lab', desc: 'Real numbers from this session — orders, spend, blocked attempts, revenue, AOV, an illustrative uplift comparison, and a strategy-comparison table (No upsell/Bundle/Discount/Free delivery) with an AI-recommended pick.', action: { type: 'dashboard' } }
    ]
  }
];

function renderFeaturesModal() {
  featuresBody.innerHTML = FEATURE_GROUPS.map(group => `
    <div class="feature-group">
      <div class="feature-group-title">${escapeHtml(group.title)}</div>
      ${group.items.map(item => `
        <div class="feature-row">
          <div class="feature-row-text">
            <div class="feature-row-name">${escapeHtml(item.name)}</div>
            <div class="feature-row-desc">${escapeHtml(item.desc)}</div>
          </div>
          ${item.action ? `<button type="button" class="feature-try-btn" data-name="${escapeHtml(item.name)}">Try it</button>` : ''}
        </div>
      `).join('')}
    </div>
  `).join('');

  featuresBody.querySelectorAll('.feature-try-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = FEATURE_GROUPS.flatMap(g => g.items).find(i => i.name === btn.dataset.name);
      if (!item || !item.action) return;
      featuresModalBackdrop.hidden = true;
      if (item.action.type === 'chat') {
        sendMessage(item.action.value);
      } else if (item.action.type === 'attack') {
        attackPanel.hidden = false;
      } else if (item.action.type === 'dashboard') {
        openDashboard();
      }
    });
  });
}

featuresBtn.addEventListener('click', () => {
  renderFeaturesModal();
  featuresModalBackdrop.hidden = false;
});
closeFeaturesBtn.addEventListener('click', () => { featuresModalBackdrop.hidden = true; });
featuresModalBackdrop.addEventListener('click', e => {
  if (e.target === featuresModalBackdrop) featuresModalBackdrop.hidden = true;
});

const dashboardBtn = document.getElementById('dashboardBtn');
const dashboardModalBackdrop = document.getElementById('dashboardModalBackdrop');
const closeDashboardBtn = document.getElementById('closeDashboardBtn');
const dashboardBody = document.getElementById('dashboardBody');
let currentDashboardData = null;
let currentDashboardTab = 'buyer';

function fmtInr(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }

/**
 * The three dashboard views are intentionally kept separate from the modal's body
 * element. They are now returned as HTML so the persistent BUSINESS surface and
 * the legacy modal render from the same function — two copies of a revenue
 * table that can disagree is exactly the sort of thing a judge notices.
 */
function dashboardHtml(tab) {
  if (!currentDashboardData) return '<div class="cc-panel-idle"><p>No data yet.</p></div>';
  const { buyer, merchant, simulator } = currentDashboardData;

  if (tab === 'buyer') {
    return `
      <div class="dash-grid">
        <div class="dash-stat"><div class="dash-stat-label">Orders placed</div><div class="dash-stat-value">${buyer.ordersPlaced}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">Spent today</div><div class="dash-stat-value">${fmtInr(buyer.spentTodayInr)}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">Blocked attempts</div><div class="dash-stat-value">${buyer.blockedAttempts}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">Human approvals given</div><div class="dash-stat-value">${buyer.humanApprovalsGiven}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">Negotiations won</div><div class="dash-stat-value">${buyer.negotiationsWon}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">Daily limit</div><div class="dash-stat-value">${fmtInr(buyer.mandate.dailyLimitInr)}</div></div>
      </div>
      <div class="dash-note">Your mandate: max ₹${buyer.mandate.maxTransactionInr.toLocaleString('en-IN')} per transaction, autonomous up to ₹${buyer.mandate.autonomousSpendThresholdInr.toLocaleString('en-IN')}. Blocked categories: ${buyer.mandate.blockedCategories.join(', ') || 'none'}.</div>
    `;
  } else if (tab === 'merchant') {
    return `
      <div class="dash-grid">
        <div class="dash-stat"><div class="dash-stat-label">Total revenue</div><div class="dash-stat-value">${fmtInr(merchant.totalRevenueInr)}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">Orders</div><div class="dash-stat-value">${merchant.orderCount}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">Avg order value</div><div class="dash-stat-value">${fmtInr(merchant.aovInr)}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">Negotiated orders</div><div class="dash-stat-value">${merchant.negotiatedOrders}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">AI-assisted revenue</div><div class="dash-stat-value">${fmtInr(merchant.aiAssistedRevenueInr)}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">Risky txns blocked</div><div class="dash-stat-value">${merchant.blockedByRiskControls}</div></div>
      </div>
      <div class="dash-note">"AI-assisted revenue" = orders that went through Merchant Agent negotiation. "Risky transactions blocked" reflects trust/policy checks that prevented a purchase — framed here as risk the merchant didn't have to absorb.</div>
    `;
  } else {
    const hasData = merchant.orderCount > 0;
    return `
      <div class="dash-compare">
        <div class="dash-compare-col">
          <div class="dash-compare-title">Without agent (baseline)</div>
          <div class="dash-compare-metric">${simulator.baselineConversionPct}%</div>
          <div style="font-size:11px;color:var(--paper-dim)">conversion</div>
          <div class="dash-compare-metric" style="margin-top:10px;">${fmtInr(simulator.baselineAovInr)}</div>
          <div style="font-size:11px;color:var(--paper-dim)">AOV</div>
        </div>
        <div class="dash-compare-col highlight">
          <div class="dash-compare-title">With paymandate agent</div>
          <div class="dash-compare-metric">${simulator.simulatedConversionPct}%</div>
          <div style="font-size:11px;color:var(--paper-dim)">conversion</div>
          <div class="dash-compare-metric" style="margin-top:10px;">${fmtInr(simulator.simulatedAovInr)}</div>
          <div style="font-size:11px;color:var(--paper-dim)">AOV</div>
        </div>
      </div>
      ${hasData ? `<div class="dash-uplift">+${simulator.upliftPct}% estimated AOV uplift</div>` : ''}
      <div class="dash-note">${simulator.note}${!hasData ? ' Place at least one order in this session to see a live comparison.' : ''}</div>

      <div class="feature-group-title" style="margin-top:18px;">Revenue Lab — strategy comparison</div>
      <table class="lab-table">
        <thead><tr><th>Strategy</th><th>Conversion</th><th>AOV</th></tr></thead>
        <tbody>
          ${currentDashboardData.revenueLab.strategies.map(s => `
            <tr class="${s.strategy === currentDashboardData.revenueLab.recommendedStrategy ? 'lab-recommended' : ''}">
              <td>${escapeHtml(s.strategy)}${s.strategy === currentDashboardData.revenueLab.recommendedStrategy ? ' 🏆' : ''}</td>
              <td>${s.conversionPct}%</td>
              <td>${fmtInr(s.aovInr)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="dash-note">AI recommends: <strong style="color:var(--brass)">${escapeHtml(currentDashboardData.revenueLab.recommendedStrategy)}</strong>. ${currentDashboardData.revenueLab.note}</div>
    `;
  }
}

function renderDashboardTab() {
  dashboardBody.innerHTML = dashboardHtml(currentDashboardTab);
}

/* ---------- BUSINESS surface ----------
 * Same data as the modal, but persistent and reachable from the nav, because a
 * business case buried behind a button gets asked about instead of read.
 * control.js calls this by name when the surface is shown. */
const businessSurfaceBody = document.getElementById('businessSurfaceBody');
let businessTab = 'buyer';

async function loadBusinessSurface() {
  if (!businessSurfaceBody) return;
  try {
    // Always refetch: the numbers move as the session buys things, and a stale
    // "0 orders placed" beside a completed purchase reads as a broken build.
    const res = await fetch(`/api/dashboard/${sessionId}`);
    currentDashboardData = await res.json();
    businessSurfaceBody.innerHTML = dashboardHtml(businessTab);
  } catch (err) {
    businessSurfaceBody.innerHTML = `<div class="cc-panel-idle"><p>Could not load business data: ${escapeHtml(err.message)}</p></div>`;
  }
}
window.loadBusinessSurface = loadBusinessSurface;

document.querySelectorAll('.biz-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.biz-tab').forEach(t => {
      t.classList.remove('is-active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('is-active');
    tab.setAttribute('aria-selected', 'true');
    businessTab = tab.dataset.biz;
    if (businessSurfaceBody) businessSurfaceBody.innerHTML = dashboardHtml(businessTab);
  });
});

async function openDashboard() {
  dashboardModalBackdrop.hidden = false;
  dashboardBody.innerHTML = 'Loading…';
  try {
    const res = await fetch(`/api/dashboard/${sessionId}`);
    currentDashboardData = await res.json();
    renderDashboardTab();
  } catch (err) {
    dashboardBody.innerHTML = 'Could not load dashboard data.';
  }
}

dashboardBtn.addEventListener('click', openDashboard);
closeDashboardBtn.addEventListener('click', () => { dashboardModalBackdrop.hidden = true; });
dashboardModalBackdrop.addEventListener('click', e => {
  if (e.target === dashboardModalBackdrop) dashboardModalBackdrop.hidden = true;
});
document.querySelectorAll('.dashboard-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.dashboard-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentDashboardTab = tab.dataset.tab;
    renderDashboardTab();
  });
});

// Attack Mode is a surface, not a popover. The topbar button is kept
// as a second route to it — a judge who reached for the red button should not
// have to discover the nav to find what they expected.
attackModeBtn.addEventListener('click', () => {
  attackPanel.hidden = false;
  openInspect('security');
});

closeAttackPanelBtn.addEventListener('click', () => {
  closeInspect();
});

const ATTACK_STAGE_MAP = { info: 'attack', detected: 'detected', neutralized: 'evaluated', blocked: 'blocked' };
const runSecuritySuiteBtn = document.getElementById('runSecuritySuiteBtn');

// The registry is the authority for the Security Lab. Do not duplicate its
// size in the UI: judges should see the actual registered count after an
// attack is added or removed, not a stale marketing number.
async function refreshSecurityAttackCount() {
  const count = document.getElementById('securityAttackCount');
  if (!count) return;
  try {
    const res = await fetch('/api/security/attacks');
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.attacks)) throw new Error('Attack registry unavailable');
    count.textContent = String(data.attacks.length);
  } catch {
    count.textContent = 'Registered';
  }
}

refreshSecurityAttackCount();

document.querySelectorAll('.attack-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const attackType = btn.dataset.attack;
    document.querySelectorAll('.attack-btn').forEach(b => b.disabled = true);
    attackLog.innerHTML = '';

    const loadingStep = document.createElement('div');
    loadingStep.className = 'attack-step';
    loadingStep.textContent = 'Running against the live pipeline…';
    attackLog.appendChild(loadingStep);

    try {
      const res = await fetch('/api/attack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, attackType })
      });
      const data = await res.json();
      attackLog.innerHTML = '';

      for (const step of data.timeline) {
        await wait(450);
        const el = document.createElement('div');
        el.className = 'attack-step';
        el.dataset.stage = ATTACK_STAGE_MAP[step.status] || 'attack';
        el.innerHTML = `<div><strong>${escapeHtml(step.label)}</strong><div style="margin-top:3px;font-size:12px;color:var(--paper-dim);">${escapeHtml(step.detail)}</div></div>`;
        attackLog.appendChild(el);
      }

      await wait(300);
      const finalEl = document.createElement('div');
      finalEl.className = 'attack-step';
      finalEl.dataset.stage = 'blocked';
      finalEl.style.fontWeight = '700';
      const decisionLabel = data.blocked ? '🔴 BLOCKED — PAYMENT NOT EXECUTED'
        : data.decision === 'NEUTRALIZED' ? '🟢 NEUTRALIZED — PAYMENT NOT EXECUTED'
        : data.decision === 'RECOVERED' ? '🟢 RECOVERED — VERIFY BEFORE RETRY'
        : String(data.finalDecision || data.decision || 'UNKNOWN').toUpperCase();
      finalEl.innerHTML = `<div>Final decision: ${decisionLabel}</div>`;
      attackLog.appendChild(finalEl);

      if (Array.isArray(data.defenseChain)) {
        const chainEl = document.createElement('div');
        chainEl.className = 'attack-step';
        chainEl.dataset.stage = 'evaluated';
        chainEl.innerHTML = `<div><strong>Defense chain</strong><div style="margin-top:3px;font-size:12px;color:var(--paper-dim);">${data.defenseChain.map(escapeHtml).join(' → ')}</div></div>`;
        attackLog.appendChild(chainEl);
      }

      // An attack that reached the pipeline leaves marks on it. Refresh the
      // Control Center so CONTROL and PAYMENTS agree with what just happened
      // here instead of still showing the state from before the attack.
      if (window.MandateControl) window.MandateControl.refresh(sessionId);
    } catch (err) {
      attackLog.innerHTML = `<div class="attack-step">Attack simulation failed: ${escapeHtml(err.message)}</div>`;
    } finally {
      document.querySelectorAll('.attack-btn').forEach(b => b.disabled = false);
    }
  });
});

runSecuritySuiteBtn.addEventListener('click', async () => {
  document.querySelectorAll('.attack-btn').forEach(b => b.disabled = true);
  attackLog.innerHTML = '<div class="attack-step">Running all registered attacks against the live security engines…</div>';
  try {
    const res = await fetch('/api/security/suite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Security suite failed');
    attackLog.innerHTML = `<div class="attack-score"><strong>${data.score.defended} / ${data.score.total}</strong><span>attacks defended or safely recovered</span></div>`;
    for (const result of data.results) {
      const row = document.createElement('div');
      row.className = 'attack-step';
      row.dataset.stage = result.blocked ? 'blocked' : 'evaluated';
      const status = result.blocked ? 'BLOCKED · payment not executed'
        : result.decision === 'NEUTRALIZED' ? 'NEUTRALIZED · payment not executed'
          : 'RECOVERED · verify before retry';
      row.innerHTML = `<div><strong>${escapeHtml(result.attackName)}</strong><div style="margin-top:3px;font-size:12px;color:var(--paper-dim);">${status} · ${escapeHtml(result.detectionReason)}</div></div>`;
      attackLog.appendChild(row);
    }
    if (window.MandateControl) window.MandateControl.refresh(sessionId);
  } catch (err) {
    attackLog.innerHTML = `<div class="attack-step">Security suite failed: ${escapeHtml(err.message)}</div>`;
  } finally {
    document.querySelectorAll('.attack-btn').forEach(b => b.disabled = false);
  }
});

chatInput.focus();
