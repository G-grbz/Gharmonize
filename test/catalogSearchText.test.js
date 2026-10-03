import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  cleanCatalogTitleForSearch, catalogSearchTextVariants, catalogQueryKey
} from '../modules/catalogSearchText.js';

test('Catalogue searches remove video presentation labels but retain real musical versions', () => {
  for (const suffix of ['(Clip Officiel)', '[Official Music Video]', '(Official 4K Video)', '- Official Audio']) {
    assert.equal(cleanCatalogTitleForSearch(`Dernière Danse ${suffix}`), 'Dernière Danse');
  }
  for (const version of ['Live', 'Acoustic', 'Remix', 'Cover', 'Remastered', 'Radio Edit', 'Love Song']) {
    const title = `Dernière Danse (${version})`;
    assert.equal(cleanCatalogTitleForSearch(title), title);
  }
});

test('Accented search alternatives remain distinct without changing display metadata', () => {
  assert.deepEqual(catalogSearchTextVariants('Dernière Danse'), ['Dernière Danse', 'Derniere Danse']);
  assert.deepEqual(catalogSearchTextVariants('Derni\u0065\u0300re Danse'), ['Dernière Danse', 'Derniere Danse']);
  assert.deepEqual(catalogSearchTextVariants('Beyoncé Déjà Vu'), ['Beyoncé Déjà Vu', 'Beyonce Deja Vu']);
  assert.deepEqual(catalogSearchTextVariants('Indila'), ['Indila']);
  assert.notEqual(catalogQueryKey('Dernière Danse'), catalogQueryKey('Derniere Danse'));
  assert.equal(catalogQueryKey('Dernière Danse'), catalogQueryKey('Derni\u0065\u0300re Danse'));
});

test('Spotify queries try the accent-free variant and match the original catalogue title safely', async () => {
  const source = fs.readFileSync(new URL('../modules/spotify.js', import.meta.url), 'utf8');
  const matching = source.slice(source.indexOf('const LOCALE_CHAR_FOLD_MAP'), source.indexOf('// Handles track to ID3 metadata meta'));
  const queries = [];
  const track = { id: 'real', name: 'Dernière Danse', artists: [{ name: 'Indila' }], duration_ms: 213493 };
  const context = vm.createContext({
    cleanCatalogTitleForSearch, catalogSearchTextVariants, catalogQueryKey,
    resolveMarket: () => 'TR',
    async makeSpotify() { return {
      async searchTracks(query) {
        queries.push(query);
        return { body: { tracks: { items: query === 'Indila Derniere Danse' ? [track] : [] } } };
      }
    }; }
  });
  vm.runInContext(matching.replace(/^export /gm, '') + '\nglobalThis.search = searchSpotifyBestTrackStrict;', context);
  assert.equal(await context.search('Indila', 'Dernière Danse (Clip Officiel)', 'TR'), track);
  assert.deepEqual(queries, ['Indila Dernière Danse', 'Indila Derniere Danse']);
  assert.equal(track.name, 'Dernière Danse');
  const wrongArtist = { ...track, id: 'cover', artists: [{ name: 'Unrelated Cover Artist' }] };
  context.makeSpotify = async () => ({ async searchTracks() { return { body: { tracks: { items: [wrongArtist] } } }; } });
  assert.equal(await context.search('Indila', 'Dernière Danse (Clip Officiel)', 'TR'), null);
});
