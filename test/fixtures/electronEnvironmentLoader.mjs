export async function resolve(specifier, context, nextResolve) {
  if (specifier !== 'electron') return nextResolve(specifier, context);
  const source = `export const app = {
    isPackaged: process.env.GHARMONIZE_TEST_PACKAGED !== '0',
    setName(name) { if (name !== 'Gharmonize') throw new Error('Unexpected application name'); },
    getPath(name) { if (name !== 'userData') throw new Error('Unexpected profile path'); return process.env.GHARMONIZE_TEST_PROFILE_DIR; }
  };`;
  return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
}
