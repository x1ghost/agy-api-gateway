import { randomUUID } from 'node:crypto'

export function waitForSignal(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      signal.removeEventListener('abort', abort)
      settle(value)
    }
    const abort = () => finish(reject, signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error))
    if (signal.aborted) abort()
  })
}

export function logRequest(row) {
  if (process.env.AGY_DIAGNOSTICS !== '0') process.stderr.write('agy_request ' + JSON.stringify(row) + '\n')
}

export function requestTiming(id = randomUUID()) {
  const start = performance.now(), stages = {}
  let phase = 'request', finished = false
  const elapsed = () => Math.round(performance.now() - start)
  return {
    id,
    mark(name) {
      if (finished || Object.hasOwn(stages, name)) return
      stages[name] = elapsed()
      phase = name
    },
    finish(logger, status, outcome, upstreamStatus) {
      if (finished) return
      finished = true
      try {
        logger({ event: 'generation', time: new Date().toISOString(), request_id: id, status, outcome, phase,
          duration_ms: elapsed(), stages_ms: stages, ...(upstreamStatus == null ? {} : { upstream_status: upstreamStatus }) })
      } catch {} // Logging must not delay or interrupt cleanup.
    },
  }
}
