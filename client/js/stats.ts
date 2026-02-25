/**
 * Stats module — polls wallet balance + session message count
 * Updates the stats-bar chips every 30s
 */

const WALLET = '0x0b538084856f9573C8d971dfCe633a5Fb221af2C';
const BASE_RPC = 'https://mainnet.base.org';
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function callRPC(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json() as { result?: unknown };
  return data.result;
}

function padAddress(addr: string): string {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

async function getUSDC(): Promise<string> {
  const data = '0x70a08231' + padAddress(WALLET);
  const result = await callRPC('eth_call', [{ to: USDC_CONTRACT, data }, 'latest']) as string;
  const raw = parseInt(result, 16);
  if (isNaN(raw)) return '—';
  return '$' + (raw / 1e6).toFixed(2);
}

async function getETH(): Promise<string> {
  const result = await callRPC('eth_getBalance', [WALLET, 'latest']) as string;
  const raw = parseInt(result, 16);
  if (isNaN(raw)) return '—';
  return (raw / 1e18).toFixed(4);
}

function setVal(id: string, val: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

async function refreshWallet() {
  try {
    const [usdc, eth] = await Promise.all([getUSDC(), getETH()]);
    setVal('stat-usdc', usdc);
    setVal('stat-eth', eth);
  } catch {
    // silently fail
  }
}

// Message count from ws events
let msgCount = 0;

export function incrementMsgCount() {
  msgCount++;
  setVal('stat-msgs', String(msgCount));
}

// Task banner
export function setTask(text: string) {
  const banner = document.getElementById('task-banner');
  const textEl = document.getElementById('task-text');
  if (!banner || !textEl) return;
  if (!text) {
    banner.classList.remove('visible');
    return;
  }
  const short = text.length > 120 ? text.slice(0, 120) + '…' : text;
  textEl.textContent = short;
  banner.classList.add('visible');
}

export function initStats() {
  refreshWallet();
  setInterval(refreshWallet, 30_000);
}
