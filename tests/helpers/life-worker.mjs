import {createLifeStore} from '../../tools/lib/life-store.mjs'
const store=createLifeStore({dshHome:process.argv[2],account:'1',owner:'2'})
for(let i=0;i<10;i++)await store.record('observed',{text:process.argv[3]+':'+i})
