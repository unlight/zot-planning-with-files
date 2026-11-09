import { writerOpts } from 'changelog-sentence-case';

/**
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: ['master'],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'conventionalcommits',
      },
    ],
    [
      '@semantic-release/release-notes-generator',
      {
        preset: 'conventionalcommits',
        writerOpts,
      },
    ],
    '@semantic-release/changelog',
    [
      '@semantic-release/exec',
      {
        // Runs before the release commit, so the tag carries the new version.
        prepareCmd:
          'node src/sync-version.ts ${nextRelease.version} && npm run build',
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: [
          'CHANGELOG.md',
          'extension.json',
          'package.json',
          'package-lock.json',
          'dist/index.js',
        ],
      },
    ],
    [
      '@semantic-release/github',
      {
        // Fresh repositories have no labels; the default 422s.
        labels: false,
      },
    ],
  ],
};
