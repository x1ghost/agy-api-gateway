// Magpie identifies the originating agent before it routes a request. Keep
// that information for this provider only; the provider removes this field
// before translating the request for AGY.
export function onProvider(body,ctx){
  if((ctx?.provider?.id!=='claude-agy'&&ctx?.provider?.id!=='claude-agy-plugin')||ctx?.agent!=='dsh')return
  return {...body,metadata:{...(body.metadata||{}),__agy_magpie_agent:'dsh'}}
}
