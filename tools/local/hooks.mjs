const subscriptions=new Map()
export const hooks={on(event,handler){const list=subscriptions.get(event)??[];list.push(handler);subscriptions.set(event,list);return ()=>subscriptions.set(event,list.filter(x=>x!==handler))},count(event){return (subscriptions.get(event)??[]).length},async emit(event,context){for(const handler of subscriptions.get(event)??[])await handler(context)}}
