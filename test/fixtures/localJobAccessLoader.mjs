// Keep the real HTTP routes and authorization, but never start a media worker
// or contact a provider during the local-file authorization regression tests.
const queueUrl = new URL('../../modules/queue.js', import.meta.url).href;
const processorUrl = new URL('../../modules/processor.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  let source;
  if (resolved.url === queueUrl) {
    source = `
      export function enqueueJob(id) {
        (globalThis.queuedLocalAccessJobs ||= []).push(id);
      }
      export function getQueuedJobIds() { return globalThis.queuedLocalAccessJobs || []; }
    `;
  } else if (resolved.url === processorUrl) {
    source = `export function processJob() { throw new Error('Media workers must not run in this fixture'); }`;
  } else {
    return resolved;
  }
  return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
}
