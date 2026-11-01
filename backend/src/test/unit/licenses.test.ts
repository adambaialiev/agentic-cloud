import { describe, expect, it } from 'vitest';
import { LICENSE_FILE, detectLicense, readmeDescription } from '../../shared/licenses.js';

describe('naming a licence file', () => {
  it('names the common licences by their distinctive words, whatever the title says', () => {
    expect(detectLicense('MIT License\n\nCopyright (c) 2026 Acme\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software')).toBe('MIT');
    expect(detectLicense('Copyright 2026\n\nPermission is hereby granted, free of charge,\nto any person obtaining a copy')).toBe('MIT');
    expect(detectLicense('                                 Apache License\n                           Version 2.0, January 2004')).toBe('Apache-2.0');
    expect(detectLicense('                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007')).toBe('GPL-3.0');
    expect(detectLicense('GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007')).toBe('AGPL-3.0');
    expect(detectLicense('GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1, February 1999')).toBe('LGPL-2.1');
    expect(detectLicense('Mozilla Public License Version 2.0\n==================================')).toBe('MPL-2.0');
    expect(detectLicense('ISC License\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted')).toBe('ISC');
    expect(detectLicense('Redistribution and use in source and binary forms, with or without modification, are permitted provided that ... 3. Neither the name of the copyright holder')).toBe('BSD-3-Clause');
    expect(detectLicense('Redistribution and use in source and binary forms, with or without modification, are permitted provided that ... 2. Redistributions in binary form')).toBe('BSD-2-Clause');
    expect(detectLicense('This is free and unencumbered software released into the public domain.')).toBe('Unlicense');
    expect(detectLicense('CC0 1.0 Universal\n\nCREATIVE COMMONS CORPORATION IS NOT A LAW FIRM')).toBe('CC0-1.0');
  });

  it('says nothing for a licence it does not know, rather than guessing', () => {
    expect(detectLicense('All rights reserved. Ask before using.')).toBeNull();
    expect(detectLicense('')).toBeNull();
  });

  it('finds the licence file by the same rule publishing uses', () => {
    for (const name of ['LICENSE', 'LICENCE', 'license.md', 'COPYING', 'LICENSE.txt']) expect(LICENSE_FILE.test(name), name).toBe(true);
    for (const name of ['LICENSES', 'license.js', 'README.md']) expect(LICENSE_FILE.test(name), name).toBe(false);
  });
});

describe('a README’s first paragraph as a description', () => {
  it('skips the title, badges, images and html and strips inline markdown', () => {
    const readme = '# Site\n\n[![CI](https://ci/badge.svg)](https://ci)\n<p align="center"><img src="logo.png"></p>\n\nThe **workplace’s** public [site](https://x), built by _agents_.\nSecond line of the same paragraph.\n\n## Install\n\nnpm i';
    expect(readmeDescription(readme)).toBe('The workplace’s public site, built by agents. Second line of the same paragraph.');
  });

  it('cuts a long paragraph at a word and says so, and answers null for a README with no prose', () => {
    const long = `Intro. ${'word '.repeat(80)}end.`;
    const description = readmeDescription(long, 60)!;
    expect(description.length).toBeLessThanOrEqual(61);
    expect(description.endsWith('…')).toBe(true);
    expect(description).not.toMatch(/ …$/);
    expect(readmeDescription('# Only a title\n\n```\ncode\n```\n')).toBeNull();
    expect(readmeDescription('')).toBeNull();
  });
});
