// Upgrade an already-running dashboard's previous viewer markup as well. This
// lets a presentation-only update preserve its worker browser and run lease.
function compactViewer(root) {
    root.querySelector('.live-browser-text')?.remove();
    if (root.querySelector('[data-live-summary]')) {
        const controls = root.querySelector('.live-browser-controls'), finish = root.querySelector('[data-action=finish]');
        if (controls && finish) controls.append(finish);
        root.querySelectorAll('p.test-page-note:not([data-live-status]), .live-step-controls small').forEach(note => note.remove());
        return;
    }
    const controls = root.querySelector('.live-browser-controls'), steps = root.querySelector('[data-step-controls]');
    const next = root.querySelector('[data-action=next-step]'), finish = root.querySelector('[data-action=finish]');
    const status = root.querySelector('[data-live-status]'), earlier = root.querySelector('[data-earlier-review]');
    const notes = [...root.querySelectorAll(':scope > p.test-page-note')].filter(note => note !== status);
    const bar = document.createElement('div'); bar.className = 'live-browser-summary';
    const brief = document.createElement('span'); brief.dataset.liveSummary = ''; brief.setAttribute('role', 'status'); brief.textContent = 'Connecting…'; bar.append(brief);
    if (next) { const primary = document.createElement('div'); primary.className = 'live-step-primary'; primary.dataset.stepControls = ''; primary.hidden = true; primary.append(next); bar.append(primary); }
    const options = document.createElement('details'); options.className = 'live-browser-options'; options.dataset.liveOptions = '';
    const toggle = document.createElement('summary'); toggle.textContent = 'Controls & status';
    const body = document.createElement('div'); body.className = 'live-controls-body'; options.append(toggle, body);
    if (controls) { controls.append(finish); body.append(controls); }
    if (status) { status.removeAttribute('role'); body.append(status); }
    if (steps) { steps.removeAttribute('data-step-controls'); steps.dataset.stepOptions = ''; steps.querySelector('[data-step-status]')?.removeAttribute('role'); steps.querySelector('small')?.remove(); body.append(steps); }
    if (earlier) body.append(earlier);
    notes.forEach(note => note.remove());
    root.prepend(bar, options);
    if (!document.querySelector('[data-compact-dock-styles]')) {
        const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/live-run.css?dock=compact-1'; style.dataset.compactDockStyles = ''; document.head.append(style);
    }
}

export function attach(root, runId) {
    installReviewStepDescriptions();
    compactViewer(root);
    const route = `/api/runs/${encodeURIComponent(runId)}/browser`;
    const stage = root.querySelector('.live-browser-stage'), image = stage.querySelector('img');
    const status = root.querySelector('[data-live-status]'), error = root.querySelector('[data-live-error]');
    const finish = root.querySelector('[data-action=finish]');
    const zoom = root.querySelector('[data-action=zoom]');
    const brief = root.querySelector('[data-live-summary]'), optionsToggle = root.querySelector('[data-live-options] > summary');
    const stepControls = root.querySelector('[data-step-controls]'), stepStatus = root.querySelector('[data-step-status]');
    const stepOptions = root.querySelector('[data-step-options]');
    const nextStep = root.querySelector('[data-action=next-step]'), remainingSteps = root.querySelector('[data-action=remaining-steps]'), cancelRun = root.querySelector('[data-action=cancel-run]');
    let currentStepId = null, canAdvance = false, advancing = false;
    const abort = new AbortController(); let disposed = false, canControl = false, sequence = -1, timer, objectUrl, actual = false;
    let inputs = Promise.resolve();
    const listeners = [];
    const on = (element, type, handler, options) => { if (!element) return; element.addEventListener(type, handler, options); listeners.push(() => element.removeEventListener(type, handler, options)); };
    const failure = message => { error.textContent = message; error.hidden = !message; };
    const post = async (suffix, body = {}) => {
        const response = await fetch(route + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal });
        if (!response.ok) { let message = 'The live browser is unavailable.'; try { message = (await response.json()).error || message; } catch {} throw new Error(message); }
    };
    const send = command => {
        if (!canControl) return;
        const stepId = root.dataset.phase === 'automating' ? currentStepId : null;
        inputs = inputs.then(() => post('/input', { ...command, stepId })).catch(exception => { if (!disposed) failure(exception.message); });
    };
    const position = event => {
        const box = image.getBoundingClientRect();
        return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) };
    };
    on(image, 'click', event => { if (!canControl) return; stage.focus({ preventScroll: true }); send({ type: 'click', ...position(event), clickCount: event.detail > 1 ? 2 : 1 }); });
    on(image, 'wheel', event => { if (!canControl) return; event.preventDefault(); send({ type: 'wheel', ...position(event), deltaX: Math.max(-2000, Math.min(2000, event.deltaX)), deltaY: Math.max(-2000, Math.min(2000, event.deltaY)) }); }, { passive: false });
    const special = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
    on(stage, 'keydown', event => {
        if (!canControl || event.isComposing) return;
        if (event.key === 'Escape' && event.shiftKey) { event.preventDefault(); stage.blur(); optionsToggle.focus(); return; }
        const modifiers = [];
        for (const [flag, name] of [['ctrlKey', 'Control'], ['metaKey', 'Meta'], ['altKey', 'Alt'], ['shiftKey', 'Shift']]) if (event[flag]) modifiers.push(name);
        if (special.has(event.key) || ((event.ctrlKey || event.metaKey) && /^[acxzy]$/i.test(event.key))) {
            event.preventDefault(); send({ type: 'key', key: special.has(event.key) ? event.key : event.key.toLowerCase(), modifiers });
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && Array.from(event.key).length === 1) { event.preventDefault(); send({ type: 'text', text: event.key }); }
    });
    on(stage, 'paste', event => { if (canControl) { event.preventDefault(); const value = event.clipboardData.getData('text').slice(0, 4000); if (value) send({ type: 'text', text: value }); } });
    for (const button of root.querySelectorAll('[data-command]')) on(button, 'click', () => send({ type: button.dataset.command }));
    on(finish, 'click', async () => { try { await post('/close'); canControl = false; await refresh(); } catch (exception) { failure(exception.message); } });
    const advance = async runRemaining => {
        if (!canAdvance || advancing || !currentStepId) return;
        const stepId = currentStepId; advancing = true; canControl = false; nextStep.disabled = remainingSteps.disabled = true;
        for (const button of root.querySelectorAll('[data-command]')) button.disabled = true;
        stage.tabIndex = -1;
        try { await inputs; await post('/advance', { stepId, runRemaining }); failure(''); await refresh(); }
        catch (exception) { if (!disposed) failure(exception.message); }
        finally { advancing = false; }
    };
    on(nextStep, 'click', () => advance(false));
    on(remainingSteps, 'click', () => advance(true));
    on(cancelRun, 'click', async () => {
        cancelRun.disabled = true;
        try {
            const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', signal: abort.signal });
            if (!response.ok) throw new Error('Could not cancel this test. Open run details to check its state.');
            await refresh();
        } catch (exception) { if (!disposed) failure(exception.message); }
    });
    on(zoom, 'click', () => { actual = !actual; stage.classList.toggle('actual-size', actual); zoom.textContent = actual ? 'Fit panel' : 'Actual size'; });
    async function refresh() {
        if (disposed) return;
        try {
            const response = await fetch(route, { cache: 'no-store', signal: abort.signal });
            if (!response.ok) throw new Error('Cannot load the live test session.');
            const state = await response.json(); canControl = state.canControl && !advancing;
            const messages = {
                waiting: `Run ${state.runStatus}. Check Worker activity in the control room. Completed reviews do not block the updated worker; start scripts/start-worker.ps1 if it is offline.`,
                automating: canControl ? 'Paused before the next test step.' : 'Executing test step.',
                review: `Automation ${state.runStatus}. Acceptance: ${state.acceptance}.`,
                closed: `Browser session closed${state.closedReason === 'capacity' ? ' to keep the three newest reviews' : state.closedReason === 'worker-updated' ? ' for a worker update' : state.closedReason === 'worker-stopped' ? ' because the worker stopped' : ''} · Automation ${state.runStatus}. Recorded results and evidence remain available.`,
                disconnected: `Worker disconnected · Automation ${state.runStatus}. This last frame is not a live session. Review recorded evidence for this run.`,
                unavailable: `Live browser unavailable · Run ${state.runStatus}. Open run details for recorded evidence.`,
            };
            status.textContent = messages[state.phase] || 'Live browser unavailable.';
            const label = value => value ? value[0].toUpperCase() + value.slice(1) : '';
            const finalStep = state.stepNumber > 0 && state.stepNumber === state.stepCount;
            const stepSummary = state.canAdvance ? 'Paused before' : 'Running';
            const short = {
                waiting: `${label(state.runStatus)} · Waiting for worker`,
                automating: finalStep && state.stepStage === 'passed' ? 'Saving results…'
                    : state.stepByStep && state.stepNumber > 0 ? `${stepSummary} step ${state.stepNumber}/${state.stepCount}` : 'Automation running',
                review: `${label(state.runStatus)} · Review ready`, closed: 'Browser closed', disconnected: 'Worker disconnected', unavailable: 'Live view unavailable',
            }[state.phase] || 'Live view unavailable';
            if (brief.textContent !== short) brief.textContent = short;
            brief.title = state.stepTitle ? `${short}: ${state.stepTitle}` : status.textContent;
            root.dataset.phase = state.phase; root.dataset.runStatus = state.runStatus;
            root.dataset.canControl = String(canControl);
            currentStepId = state.stepId; canAdvance = state.canAdvance === true;
            root.dataset.stepId = state.stepId || ''; root.dataset.stepStage = state.stepStage || 'preparing';
            // A running dashboard may still have the previous viewer markup
            // while its static assets are refreshed. Keep that viewer working.
            if (stepControls) {
             const stepping = state.stepByStep && ['queued', 'running'].includes(state.runStatus);
             stepControls.hidden = !stepping;
             if (stepOptions) stepOptions.hidden = !stepping;
             nextStep.textContent = finalStep ? 'Run final step' : 'Run next step';
             nextStep.disabled = remainingSteps.disabled = !canAdvance || advancing;
             cancelRun.disabled = state.runStatus !== 'running' || state.cancelRequested;
             if (state.stepByStep) {
                const step = `Step ${state.stepNumber} of ${state.stepCount}: ${state.stepTitle || ''}`;
                stepStatus.textContent = state.runStatus === 'queued' ? 'Waiting for the worker to start this step-by-step test.'
                    : ['passed', 'failed', 'cancelled', 'interrupted'].includes(state.runStatus) ? `Test ${state.runStatus}. ${state.stepNumber ? step : ''}`
                    : state.stepNumber === 0 ? 'Preparing the isolated app and test data…'
                    : state.canAdvance ? `Paused before ${step}.`
                    : state.stepStage === 'waiting' ? 'Finishing your app input before continuing…'
                    : state.stepStage === 'passed' ? `Completed ${step}.`
                    : `Running ${step}${state.runRemaining ? ' · Continuing automatically.' : ''}`;
             }
            }
            const earlier = root.querySelector('[data-earlier-review]');
            earlier.hidden = state.phase !== 'waiting' || !state.earlierReviewRunId;
            if (!earlier.hidden) earlier.href = `/runs/${encodeURIComponent(state.earlierReviewRunId)}/live`;
            for (const button of root.querySelectorAll('[data-command]')) button.disabled = !canControl;
            finish.disabled = state.phase !== 'review' || !canControl; stage.tabIndex = canControl ? 0 : -1;
            stage.style.setProperty('--browser-width', `${state.width}px`);
            if (state.sequence > 0 && state.sequence !== sequence) {
                const frame = await fetch(`${route}/frame?sequence=${state.sequence}`, { cache: 'no-store', signal: abort.signal });
                if (frame.status === 200) {
                    const next = URL.createObjectURL(await frame.blob()); const previous = objectUrl;
                    objectUrl = next; image.src = next; image.hidden = false; if (previous) URL.revokeObjectURL(previous); sequence = state.sequence;
                }
            }
        } catch (exception) { if (!disposed) {
            canControl = false; root.dataset.phase = 'disconnected';
            canAdvance = false; for (const button of [nextStep, remainingSteps, cancelRun]) if (button) button.disabled = true;
            for (const button of root.querySelectorAll('[data-command]')) button.disabled = true;
            finish.disabled = true; stage.tabIndex = -1;
            failure(exception.message); status.textContent = 'Live connection lost. Reconnecting…';
            brief.textContent = 'Reconnecting…';
        } }
    }
    async function poll() { await refresh(); if (!disposed) timer = setTimeout(poll, 300); }
    void poll();
    return { dispose() { disposed = true; clearTimeout(timer); abort.abort(); listeners.forEach(remove => remove()); if (objectUrl) URL.revokeObjectURL(objectUrl); } };
}
import { installReviewStepDescriptions } from './review-step-description.js';

