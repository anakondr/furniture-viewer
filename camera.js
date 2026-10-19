// Camera preferences are independent of the published snapshot and URL query.
export class CameraPreferences {
 constructor(key,storage=()=>globalThis.localStorage){this.key=key;this.storage=typeof storage==='function'?storage:()=>storage;}
 valid(s){return s&&['isometric','front','side','top'].includes(s.viewMode)
  &&['position','target','up'].every(k=>Array.isArray(s[k])&&s[k].length===3&&s[k].every(Number.isFinite))
  &&['near','far','zoom','viewHeight'].every(k=>Number.isFinite(s[k])&&s[k]>0)
  &&s.far>s.near&&s.up.some(v=>v!==0)&&s.position.some((v,i)=>v!==s.target[i]);}
 load(){try{return new Map(Object.entries(JSON.parse(this.storage().getItem(this.key)||'{}')).filter(([k,v])=>['assembly','clamps'].includes(k)&&this.valid(v)));}catch{return new Map();}}
 save(views){try{this.storage().setItem(this.key,JSON.stringify(Object.fromEntries([...views].filter(([k,v])=>['assembly','clamps'].includes(k)&&this.valid(v)))));}catch{/* Storage may be unavailable in private browsing. */}}
}
