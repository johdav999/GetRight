// Compatibility for an already-running dashboard's previous review markup.
// New server-rendered cards use the same frozen run snapshot directly in Razor.
let installed = false;
export function installReviewStepDescriptions() {
    if (installed) return;
    installed = true;
    const cache = new Map(), states = new WeakMap();
    const runId = select => {
        const quick = select.closest('.quick-review');
        const path = quick ? quick.querySelector('.quick-run-identity a')?.getAttribute('href') : location.pathname;
        return path?.match(/^\/runs\/([a-f0-9]{32})\/?$/)?.[1];
    };
    const stepsFor = id => {
        if (!cache.has(id)) {
            if (cache.size >= 8) cache.delete(cache.keys().next().value);
            cache.set(id, fetch(`/api/runs/${id}`, {cache:'no-store',redirect:'error',signal:AbortSignal.timeout(4000)})
                .then(async response => { if (!response.ok) throw new Error('Run unavailable'); const run = await response.json(); return run.testSnapshot.steps; })
                .catch(() => null));
        }
        return cache.get(id);
    };
    const display = (select, id, steps) => {
        if (!select.isConnected || runId(select) !== id || select.nextElementSibling?.dataset.selectedStepDescription === 'server') return;
        let state = states.get(select);
        if (!state) {state = {}; states.set(select,state);}
        const index = steps?.findIndex(step => step.id === select.value) ?? -1, step = steps?.[index];
        const title = step?.title ?? select.selectedOptions[0]?.textContent ?? '';
        const expected = step?.expected ?? 'Expected result unavailable.';
        const signature = JSON.stringify([id,select.value,title,expected]);
        if (state.signature === signature && state.card?.isConnected) return;
        state.signature = signature;
        const card = state.card?.isConnected ? state.card : document.createElement('div'); state.card = card;
        card.className = 'selected-step-description'; card.id = `${select.id}-description`;
        card.dataset.selectedStepDescription = 'client'; card.dataset.runId = id; card.dataset.stepId = select.value;
        card.setAttribute('role','region');card.setAttribute('aria-label','Selected test step');
        const label = document.createElement('span');label.className='mini-label';label.textContent = step ? `Step ${index+1} of ${steps.length}` : 'Selected step';
        const instruction = document.createElement('p');instruction.className='selected-step-instruction';instruction.textContent=title;
        const expectedLabel = document.createElement('span');expectedLabel.className='mini-label';expectedLabel.textContent='Expected result';
        const result = document.createElement('p');result.className='selected-step-expected';result.textContent=expected;
        card.replaceChildren(label,instruction,expectedLabel,result);select.after(card);
        select.setAttribute('aria-describedby',card.id);
    };
    const inspect = () => {
        for (const select of document.querySelectorAll('select#quick-step, select#step')) {
            if (select.nextElementSibling?.dataset.selectedStepDescription === 'server') continue;
            const id = runId(select); if (!id) continue;
            // Browsing descriptions is read-only. Review/comment controls keep
            // their own server-enforced completion requirements.
            if (select.disabled) select.disabled=false;
            const state=states.get(select);
            if (state?.card?.dataset.runId !== id && state?.card?.isConnected) {state.card.remove();state.signature=null;}
            void stepsFor(id).then(steps=>display(select,id,steps));
        }
    };
    let scheduled=false;
    const schedule=()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;inspect();});};
    document.addEventListener('change',event=>{if(event.target.matches?.('select#quick-step, select#step'))schedule();});
    new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['href','disabled']});
    inspect();
}
