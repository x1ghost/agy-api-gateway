import {createHash} from 'node:crypto'

// Identity-only excerpt observed in official AGY1.5.9's native request. Do not
// import native tool/sandbox instructions or its USER_REQUEST wrapper claim.
export const AGY_IDENTITY = 'You are Antigravity, a powerful agentic AI assistant designed by the Google Deepmind team.\nYou are working with a USER to solve their task.'
export const BRIDGE_CONTEXT = 'The client controls conversation history and tool execution. Official Antigravity CLI handles authentication and model requests.'
// Exact security instruction from the captured AGY 1.5.9 native system prompt.
export const AGY_NATIVE_SECURITY = 'Never defeat or bypass an access control, permission check, credential requirement, network/proxy restriction, or sandbox/environment boundary - including writing to the state or processes such a check reads, spoofing identity, intercepting the check, probing undocumented local/host services, or modifying host, harness, or test infrastructure outside your task scope. Use documented, sanctioned paths only; if none of them work, you are blocked - report the error and stop.'
const SDK_BILLING = /^x-(?:anthropic|antigravity|anti gravity)-billing-header:\s*(?:(?:cc_version|cc_entrypoint|cch)=[^;\r\n]*;\s*)+$/i
const CLIENT_IDENTITIES = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are anti gravity Code, anti gravity's official CLI for anti gravity.",
  "You are Antigravity Code, Antigravity's official CLI for Antigravity.",
  'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.',
  'You are a anti gravity agent, built on anti gravity\'s anti gravity Agent SDK.',
  'You are a Antigravity agent, built on Antigravity\'s Antigravity Agent SDK.',
]
export function rewriteSystemIdentity(text) {
  // Match complete known identity lines, preserving all surrounding rules.
  return text.split(/(\r\n|\n|\r)/).map(line=>{
    const trimmed=line.trim()
    if(SDK_BILLING.test(trimmed))return line.match(/^\s*/)[0]+BRIDGE_CONTEXT+line.match(/\s*$/)[0]
    if(CLIENT_IDENTITIES.some(id=>id.toLowerCase()===trimmed.toLowerCase())) {
      const indent=line.match(/^\s*/)[0],trailing=line.match(/\s*$/)[0]
      return indent+AGY_IDENTITY+trailing
    }
    return line.replace(/claude|anthropic/gi,'Antigravity')
  }).join('')
}

// Evidence fingerprint for the paragraph replaced by the default policy.
export const KNOWN_REFUSED_SYSTEM_HASHES = new Set([
  '10591efdcea75a1645b7f19037b36c979849ad4ec27f11ce87a8393423597b44',
])
export const systemFingerprint = text => createHash('sha256').update(text.trim().replace(/\s+/g,' ')).digest('hex')
export function replaceKnownSecurity(text, hashes=KNOWN_REFUSED_SYSTEM_HASHES) {
  return text.split(/(\r?\n\s*\r?\n)/).map(p => hashes.has(systemFingerprint(p)) ? AGY_NATIVE_SECURITY : p).join('')
}
export function assertForwardableSystem(projected, hashes=KNOWN_REFUSED_SYSTEM_HASHES) {
  for(const part of projected.systemInstruction?.parts||[])for(const paragraph of part.text.split(/\r?\n\s*\r?\n/)) {
    if(hashes.has(systemFingerprint(paragraph)))throw Object.assign(new Error(
      'CC system instructions contain a paragraph previously refused by official AGY. Instructions were preserved; no model request was sent. This full-system combination is not yet supported by the bridge.'
    ),{status:422,code:'known_refused_system'})
  }
}
