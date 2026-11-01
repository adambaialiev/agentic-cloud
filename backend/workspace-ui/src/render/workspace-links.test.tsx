import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown.js';
function Address() { const location=useLocation(); return <output>{location.pathname}{location.search}</output>; }
const mount=(source:string,enabled=true)=>render(<MemoryRouter><Markdown source={source} workspaceLinks={enabled}/><Address/></MemoryRouter>);
describe('opt-in Workspace Markdown links',()=>{
 // A recap reply written while notes were a room's names the room too; the
 // registry reads it as the workplace's note it now is (note #843).
 it('renders the real recap reply as a same-tab note link in its workplace, an old room dropped',()=>{
  mount('Saved: [Recap runtime check](/notes/1?org=o1&room=r1).');
  const link=screen.getByRole('link',{name:'Recap runtime check'});
  expect(link.getAttribute('href')).toBe('/notes/1?org=o1');
  expect(link.hasAttribute('target')).toBe(false);
  fireEvent.click(link);expect(screen.getByRole('status').textContent).toBe('/notes/1?org=o1');
 });
 it('repairs the pseudo-host and singular note path in an already stored Workspace Agent reply',()=>{
  mount('Saved: [Back button edge case](https://workspace/note/440).');
  const link=screen.getByRole('link',{name:'Back button edge case'});
  expect(link.getAttribute('href')).toBe('/notes/440');
  expect(link.hasAttribute('target')).toBe(false);
 fireEvent.click(link);expect(screen.getByRole('status').textContent).toBe('/notes/440');
 });
 it('repairs the same pseudo-host when it was written as a bare URL',()=>{
  mount('Saved: https://workspace/note/440');
  const link=screen.getByRole('link',{name:'https://workspace/note/440'});
  expect(link.getAttribute('href')).toBe('/notes/440');
  expect(link.hasAttribute('target')).toBe(false);
 });
 it('leaves a sentence\'s full stop off the bare pseudo-host too (note #686)',()=>{
  mount('Saved at https://workspace/note/440.');
  expect(screen.getByRole('link',{name:'https://workspace/note/440'}).getAttribute('href')).toBe('/notes/440');
 });
 it('keeps relative links as prose when the screen has not opted in',()=>{
  mount('[Note](/workspace/notes/1?org=o1) [old](https://workspace/note/1)',false);expect(screen.queryByRole('link')).toBeNull();
 });
 it('does not turn unsafe or unregistered destinations into links',()=>{
  mount('[bad](javascript:alert) [external](//evil.test) [unknown](/not-a-route) [escape](/../outside) [dot](/notes/..) [encoded](/notes/%2e%2e)');
  expect(screen.queryAllByRole('link')).toHaveLength(0);
 });
 it('preserves code spans and fences while allowing a formatted link label',()=>{
  mount('`[Code](/notes/1)`\n\n**[Open note](/notes/1?org=o1)**\n\n```md\n[Fenced](/notes/1)\n```');
  expect(screen.getAllByRole('link')).toHaveLength(1);expect(screen.getByRole('link').textContent).toBe('Open note');
  expect(screen.getByText('[Code](/notes/1)').tagName).toBe('CODE');
 });
});
