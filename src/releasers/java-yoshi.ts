/**
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ReleasePR, ReleasePROptions, ReleaseCandidate } from '../release-pr';
import * as semver from 'semver';

import { ConventionalCommits } from '../conventional-commits';
import { GitHubTag } from '../github';
import { checkpoint, CheckpointType } from '../util/checkpoint';
import { Update, VersionsMap } from '../updaters/update';
import { Commit } from '../graphql-to-commits';

// Generic
import { Changelog } from '../updaters/changelog';
// Java
import { PomXML } from '../updaters/java/pom-xml';
import { VersionsManifest } from '../updaters/java/versions-manifest';
import { Readme } from '../updaters/java/readme';

const CHANGELOG_SECTIONS = [
  { type: 'feat', section: 'Features' },
  { type: 'fix', section: 'Bug Fixes' },
  { type: 'perf', section: 'Performance Improvements' },
  { type: 'deps', section: 'Dependencies' },
  { type: 'revert', section: 'Reverts' },
  { type: 'docs', section: 'Documentation' },
  { type: 'style', section: 'Styles', hidden: true },
  { type: 'chore', section: 'Miscellaneous Chores', hidden: true },
  { type: 'refactor', section: 'Code Refactoring', hidden: true },
  { type: 'test', section: 'Tests', hidden: true },
  { type: 'build', section: 'Build System', hidden: true },
  { type: 'ci', section: 'Continuous Integration', hidden: true },
];

export class JavaYoshi extends ReleasePR {
  constructor(options: ReleasePROptions) {
    if (!options.label && options.snapshot) {
      options.label = 'type: process';
    }
    super(options);
  }

  protected async _run() {
    const versionsManifestContent = await this.gh.getFileContents(
      'versions.txt'
    );
    const currentVersions = VersionsManifest.parseVersions(
      versionsManifestContent.parsedContent
    );
    this.snapshot = VersionsManifest.needsSnapshot(
      versionsManifestContent.parsedContent
    );

    const latestTag: GitHubTag | undefined = await this.gh.latestTag();
    const commits: Commit[] = this.snapshot
      ? [
          {
            sha: 'abc123',
            message: 'fix: ',
            files: [],
          },
        ]
      : await this.commits(latestTag ? latestTag.sha : undefined, 100, true);
    let prSHA = commits[0].sha;

    const cc = new ConventionalCommits({
      commits,
      githubRepoUrl: this.repoUrl,
      bumpMinorPreMajor: this.bumpMinorPreMajor,
      changelogSections: CHANGELOG_SECTIONS,
    });
    const candidate: ReleaseCandidate = await this.coerceReleaseCandidate(
      cc,
      latestTag
    );
    const candidateVersions = await this.coerceVersions(cc, currentVersions);
    let changelogEntry: string = await cc.generateChangelogEntry({
      version: candidate.version,
      currentTag: `v${candidate.version}`,
      previousTag: candidate.previousTag,
    });

    // snapshot entries are special:
    // 1. they don't update the README or CHANGELOG.
    // 2. they always update a patch with the -SNAPSHOT suffix.
    // 3. they're haunted.
    if (this.snapshot) {
      prSHA = latestTag!.sha;
      candidate.version = `${candidate.version}-SNAPSHOT`;
      changelogEntry =
        '### Updating meta-information for bleeding-edge SNAPSHOT release.';
    }

    // don't create a release candidate until user facing changes
    // (fix, feat, BREAKING CHANGE) have been made; a CHANGELOG that's
    // one line is a good indicator that there were no interesting commits.
    if (this.changelogEmpty(changelogEntry) && !this.snapshot) {
      checkpoint(
        `no user facing commits found since ${
          latestTag ? latestTag.sha : 'beginning of time'
        }`,
        CheckpointType.Failure
      );
      return;
    }

    const updates: Update[] = [];

    if (!this.snapshot) {
      updates.push(
        new Changelog({
          path: 'CHANGELOG.md',
          changelogEntry,
          versions: candidateVersions,
          version: candidate.version,
          packageName: this.packageName,
        })
      );

      updates.push(
        new Readme({
          path: 'README.md',
          changelogEntry,
          versions: candidateVersions,
          version: candidate.version,
          packageName: this.packageName,
        })
      );
    }

    updates.push(
      new VersionsManifest({
        path: 'versions.txt',
        changelogEntry,
        versions: candidateVersions,
        version: candidate.version,
        packageName: this.packageName,
        contents: versionsManifestContent,
      })
    );

    const pomFiles = await this.gh.findFilesByFilename('pom.xml');
    pomFiles.forEach(path => {
      updates.push(
        new PomXML({
          path,
          changelogEntry,
          versions: candidateVersions,
          version: candidate.version,
          packageName: this.packageName,
        })
      );
    });

    await this.openPR(
      prSHA!,
      `${changelogEntry}\n---\n`,
      updates,
      candidate.version
    );
  }

  protected defaultInitialVersion(): string {
    return '0.1.0';
  }

  protected async coerceVersions(
    cc: ConventionalCommits,
    currentVersions: VersionsMap
  ): Promise<VersionsMap> {
    const newVersions: VersionsMap = new Map<string, string>();
    for (const [k, version] of currentVersions) {
      const bump = await cc.suggestBump(version);
      const candidate: string | null = semver.inc(version, bump.releaseType);
      if (candidate) {
        newVersions.set(k, candidate);
      } else {
        throw Error(`failed to increment ${k} @ ${version}`);
      }
    }
    return newVersions;
  }
}