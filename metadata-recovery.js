// One bounded recovery attempt per changed input; no polling or self-retry.
export function createMetadataRecovery({ read, recover, isBusy = () => false, onError = () => {},
    eventSource, changedEvents = [], chatChangedEvent, stopEvent, delay = 250 } = {}) {
    let timer = null, active = null, attempted = null, disposed = false, epoch = 0;
    const listeners = [];
    const clear = () => { clearTimeout(timer); timer = null; };
    function notify() {
        if (disposed || active || isBusy()) return;
        clear();
        const work = read();
        if (!work || work.key === attempted) return;
        timer = setTimeout(async () => {
            timer = null;
            if (disposed || active || isBusy()) return;
            const next = read();
            if (!next || next.key === attempted) return;
            attempted = next.key;
            const controller = active = new AbortController(), runEpoch = epoch;
            let succeeded = false;
            try { await recover(next, controller.signal); succeeded = true; }
            catch (error) { if (!controller.signal.aborted) onError(error); }
            finally {
                if (active === controller) {
                    active = null;
                    const current = read();
                    const inputChanged = current && (current.inputKey || current.key) !== (next.inputKey || next.key);
                    const progressed = succeeded && current && current.remaining < next.remaining;
                    // Drain successful chunks, preserve external changes during a
                    // request, and stop when the same inputs make no progress.
                    if (!disposed && (epoch !== runEpoch || !controller.signal.aborted && (inputChanged || progressed))) {
                        attempted = null; notify();
                    } else attempted = current?.key || next.key;
                }
            }
        }, delay);
    }
    function cancel() {
        clear(); attempted = read()?.key || attempted;
        active?.abort(new Error('Automatic metadata recovery stopped. Saved memory was kept.'));
    }
    const listen = (event, handler) => {
        if (!event || !eventSource) return;
        eventSource.on(event, handler); listeners.push([event, handler]);
    };
    for (const event of new Set(changedEvents.filter(Boolean))) listen(event, notify);
    listen(chatChangedEvent, () => { epoch++; cancel(); attempted = null; notify(); });
    listen(stopEvent, cancel);
    return Object.freeze({ notify, cancel, dispose() {
        disposed = true; cancel();
        for (const [event, handler] of listeners) eventSource.removeListener(event, handler);
        listeners.length = 0;
    } });
}
