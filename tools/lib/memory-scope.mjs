export const SCENES=['private-reply','private-recommendation','public-comment','reply','public-recommendation','local-management','private','public']
export const publicScene=scene=>['public','public-comment','reply','public-recommendation'].includes(scene)
export function assertScene(scene){if(!SCENES.includes(scene))throw Error('未知记忆场景');return scene}
export function visible(item,scene){assertScene(scene);return !publicScene(scene)||item.visibility==='public'||item.data?.visibility==='public'||item.kind==='video-read'||(item.kind==='sent'&&item.channel==='comment')}
export function inScope(m,scene){
 if(!visible(m,scene))return false
 if(Array.isArray(m.scope?.scenes)&&!m.scope.scenes.includes(scene)&&!['private','public','local-management'].includes(scene))return false
 const scope=m.scope?.scene
 return !scope||scope==='all'||scope===scene||(scope==='public'&&publicScene(scene))||(scope==='private'&&!publicScene(scene))||(scope==='recommend'&&scene.includes('recommendation'))||scene==='local-management'
}
