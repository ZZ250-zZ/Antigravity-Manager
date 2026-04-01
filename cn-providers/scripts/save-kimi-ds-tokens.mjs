#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
import { updateToken } from '../src/utils/token-store.mjs';

async function main() {
  const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
  const pg = (await b.pages())[0];
  const cl = await pg.createCDPSession();
  const { cookies } = await cl.send('Network.getAllCookies');

  // Kimi
  const kimiAuth = cookies.find(c => c.name === 'kimi-auth');
  if (kimiAuth) {
    await updateToken('kimi', kimiAuth.value);
    console.log('✅ Kimi token 已保存 (kimi-auth JWT)');
  }

  // DeepSeek
  const dsSession = cookies.find(c => c.name === 'ds_session_id' && c.domain.includes('deepseek'));
  if (dsSession) {
    await updateToken('deepseek', dsSession.value);
    console.log('✅ DeepSeek token 已保存 (ds_session_id)');
  }

  await cl.detach();
  b.disconnect();
}

main().catch(e => console.error(e.message));
