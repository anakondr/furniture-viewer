import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
const $ = id => document.getElementById(id);
const status = message => { $('status').textContent=message; $('status').classList.remove('error'); };
const fail = error => {console.error(error); status(error.message); $('status').classList.add('error');};
async function json(url){const r=await fetch(url);if(!r.ok)throw Error(`Cannot load ${url}: ${r.status}`);return r.json();}
const cached=new Map();
function data(url){if(!cached.has(url))cached.set(url,json(url).catch(e=>{cached.delete(url);throw e;}));return cached.get(url);}
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.outputColorSpace=THREE.SRGBColorSpace;
$('canvas').append(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#f4f1eb');
scene.add(new THREE.HemisphereLight(0xffffff,0xaaa69f,2));
const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(1,2,3);scene.add(light);
const camera=new THREE.PerspectiveCamera(35,1,.1,100000);
camera.up.set(0,1,0);
const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true;
const assembly=new THREE.Group(), fileGroup=new THREE.Group();scene.add(assembly,fileGroup);fileGroup.visible=false;
let tab='assembly', source='python', manifest, rows=[], objects=new Map(), values=[], collapsed=new Set(), visibility=new Map(), sourceRequest=0, fileRequest=0, selectedFile=null;
const geometryCache=new Map();
const walnutEnabled={value:0};
function colorAttribute(bytes){
 const a=new Float32Array(bytes.length);const c=new THREE.Color();
 for(let i=0;i<bytes.length;i+=3){c.setRGB(bytes[i]/255,bytes[i+1]/255,bytes[i+2]/255,THREE.SRGBColorSpace);a.set([c.r,c.g,c.b],i);}
 return new THREE.BufferAttribute(a,3);
}
function geometries(payload,url){
 const result={};
 if(payload.positions?.length){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(payload.positions,3));g.setAttribute('color',colorAttribute(payload.colors));if(payload.normals)g.setAttribute('normal',new THREE.Float32BufferAttribute(payload.normals,3));else g.computeVertexNormals();const marker=manifest.walnutColor||[89,82,53],oak=manifest.oakColor||[241,229,172],isOak=(manifest.oakMeshes||[]).includes(url);const mask=new Float32Array(payload.colors.length/3);for(let i=0;i<mask.length;i++)mask[i]=marker.every((v,c)=>Math.abs(payload.colors[i*3+c]-v)<=1)?1:(isOak&&oak.every((v,c)=>Math.abs(payload.colors[i*3+c]-v)<=1)?2:0);g.setAttribute('walnutMask',new THREE.BufferAttribute(mask,1));result.surface=g;}
 if(payload.lines?.length){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(payload.lines,3));g.setAttribute('color',colorAttribute(payload.lineColors));result.edges=g;}
 return result;
}
async function mesh(url){if(!geometryCache.has(url))geometryCache.set(url,data(url).then(payload=>geometries(payload,url)));const gs=await geometryCache.get(url);const group=new THREE.Group();
 if(gs.surface)group.add(new THREE.Mesh(gs.surface,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.8,metalness:0,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1})));
 if(gs.edges)group.add(new THREE.LineSegments(gs.edges,new THREE.LineBasicMaterial({vertexColors:true})));
 group.traverse(o=>{if(o.material)prepareTransparency(o.material);});
 return group;
}
function clear(group){for(const child of [...group.children]){child.traverse(o=>o.material?.dispose());group.remove(child);}}
function fit(group=tab==='files'?fileGroup:assembly){const box=new THREE.Box3().setFromObject(group);if(box.isEmpty())return;const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());const radius=size.length()/2;const distance=radius/Math.sin(THREE.MathUtils.degToRad(camera.fov/2))/Math.min(1,camera.aspect);controls.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(1,.65,1).normalize().multiplyScalar(distance*1.12));camera.near=Math.max(.01,radius/1000);camera.far=Math.max(10000,distance*20);camera.updateProjectionMatrix();controls.update();}
// Peel the nearest surface exactly, then blend the remaining transparent layers.
// No random pixel discard and no whole-object depth ordering are involved.
const transparencyPass={value:0}, transparencyDistance={value:1};
const accumulation=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false});
const revealage=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false});
const frontSurface=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType});
frontSurface.depthTexture=new THREE.DepthTexture(1,1,THREE.UnsignedIntType);
const frontDepth={value:null}, transparencySize={value:new THREE.Vector2(1,1)};
const compositeScene=new THREE.Scene();
const compositeCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
const compositeMaterial=new THREE.ShaderMaterial({
 uniforms:{frontSurface:{value:frontSurface.texture},accumulation:{value:accumulation.texture},revealage:{value:revealage.texture},background:{value:scene.background.clone()}},
 vertexShader:'varying vec2 uvScreen; void main(){uvScreen=uv;gl_Position=vec4(position.xy,0.,1.);}',
 fragmentShader:`uniform sampler2D frontSurface;uniform sampler2D accumulation;uniform sampler2D revealage;uniform vec3 background;varying vec2 uvScreen;
 void main(){vec4 a=texture2D(accumulation,uvScreen);float r=clamp(texture2D(revealage,uvScreen).r,0.,1.);
 vec3 colour=a.rgb/max(a.a,0.00001);vec4 front=texture2D(frontSurface,uvScreen);gl_FragColor=vec4(mix(mix(colour,background,r),front.rgb,front.a),1.);
 #include <colorspace_fragment>
 }`,depthTest:false,depthWrite:false});
compositeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),compositeMaterial));
function prepareTransparency(material){
 material.forceSinglePass=true;
 material.onBeforeCompile=shader=>{
  if(material.isMeshStandardMaterial){
   shader.uniforms.walnutEnabled=walnutEnabled;
   shader.vertexShader='attribute float walnutMask;varying float walnutFace;varying vec3 walnutPosition;varying vec3 walnutNormal;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nwalnutFace=walnutMask;walnutPosition=position;walnutNormal=normal;');
   shader.fragmentShader=`uniform float walnutEnabled;varying float walnutFace;varying vec3 walnutPosition;varying vec3 walnutNormal;
    float walnutHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float walnutNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(walnutHash(i),walnutHash(i+vec2(1,0)),f.x),mix(walnutHash(i+vec2(0,1)),walnutHash(i+vec2(1,1)),f.x),f.y);}
    float walnutFbm(vec2 p){return .57*walnutNoise(p)+.28*walnutNoise(p*2.03)+.15*walnutNoise(p*4.09);}
    vec3 walnutColour(vec3 p,vec3 n){
     vec2 uv=abs(n.z)>.5?p.xy:(abs(n.y)>.5?p.xz:p.yz);
     float warp=walnutFbm(vec2(uv.x*.004,uv.y*.015));
     float crown=pow(sin(uv.x*.0025+warp*.65),2.0)*22.0;
     float across=uv.y+crown+warp*12.0;
     float broad=walnutFbm(vec2(uv.x*.008,across*.055));
     float phase=across*.85+walnutNoise(uv*vec2(.01,.09))*3.0;
     float rings=.5+.5*sin(phase);
     float grain=pow(rings,12.0)*(1.0-smoothstep(.6,2.0,fwidth(phase)));
     float fibres=walnutNoise(vec2(uv.x*.035,across*2.5));
     float tone=clamp(.35+.5*broad+.12*fibres-.25*grain,0.0,1.0);
     return mix(vec3(.055,.021,.009),vec3(.29,.145,.065),tone);
    }
    vec3 oakColour(vec3 p,vec3 n){
     vec2 uv=abs(n.z)>.5?p.xy:(abs(n.y)>.5?p.xz:p.yz);
     float warp=walnutFbm(uv*vec2(.005,.02));
     float across=uv.y+warp*10.0+pow(sin(uv.x*.003),2.0)*16.0;
     float phase=across*.6+walnutNoise(uv*vec2(.009,.07))*2.5;
     float pores=pow(.5+.5*sin(phase),18.0)*(1.0-smoothstep(.7,2.0,fwidth(phase)));
     float rays=smoothstep(.83,.98,walnutNoise(uv*vec2(.15,.018)))*.13;
     float tone=clamp(.48+.35*walnutFbm(vec2(uv.x*.014,across*.15))-.23*pores+rays,0.,1.);
     return mix(vec3(.23,.12,.047),vec3(.65,.45,.23),tone);
    }
   `+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\nif(walnutEnabled>.5&&walnutFace>.99){diffuseColor.rgb=walnutFace>1.5?oakColour(walnutPosition,normalize(walnutNormal)):walnutColour(walnutPosition,normalize(walnutNormal));}');
   shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif(walnutEnabled>.5&&walnutFace>.99){roughnessFactor=(walnutFace>1.5?.62:.48)+.12*walnutNoise(walnutPosition.xy*vec2(.02,.8));}');
  }
  shader.uniforms.transparencyPass=transparencyPass;
  shader.uniforms.transparencyDistance=transparencyDistance;
  shader.uniforms.frontDepth=frontDepth;shader.uniforms.transparencySize=transparencySize;
  shader.fragmentShader='uniform sampler2D frontDepth;uniform vec2 transparencySize;uniform int transparencyPass;uniform float transparencyDistance;\n'+shader.fragmentShader;
  const end=shader.fragmentShader.lastIndexOf('}');
  shader.fragmentShader=shader.fragmentShader.slice(0,end)+`
   if(transparencyPass==1||transparencyPass==2){
    float nearest=texture2D(frontDepth,gl_FragCoord.xy/transparencySize).r;
    if(gl_FragCoord.z<=nearest+0.0000001)discard;
   }
   if(transparencyPass==3){gl_FragColor.a=opacity;}
   else if(transparencyPass==1){
    float alpha=opacity;
    float depth=1.0/gl_FragCoord.w;
    float weight=clamp(pow(transparencyDistance/max(depth,0.001),4.0),0.01,100.0);
    gl_FragColor=vec4(gl_FragColor.rgb*alpha,alpha)*weight;
   }else if(transparencyPass==2){gl_FragColor=vec4(opacity);}
  `+shader.fragmentShader.slice(end);
 };
 material.customProgramCacheKey=()=> 'furniture-wood-transparency-v4';
}
function opacity(material,value){
 material.opacity=value;
 material.alphaHash=false;
 material.transparent=value<1;
 material.depthWrite=value>=1;
}
function renderView(){
 const active=tab==='files'?fileGroup:assembly;
 const translucent=(tab==='files'?+$('file-alpha').value:+$('alpha').value)<1;
 const materials=[];active.traverse(o=>{if(o.material)materials.push(o.material);});
 if(!translucent){
  transparencyPass.value=0;
  for(const m of materials){m.blending=THREE.NormalBlending;m.transparent=false;m.depthWrite=true;}
  renderer.render(scene,camera);return;
 }
 const size=renderer.getDrawingBufferSize(new THREE.Vector2());
 if(accumulation.width!==size.x||accumulation.height!==size.y){accumulation.setSize(size.x,size.y);revealage.setSize(size.x,size.y);frontSurface.setSize(size.x,size.y);}
 transparencyDistance.value=camera.position.distanceTo(controls.target);
 const background=scene.background;scene.background=null;
 transparencySize.value.copy(size);
 // Do not sample a depth texture while it is attached to the drawing target.
 frontDepth.value=null;
 for(const m of materials){m.transparent=false;m.depthWrite=true;m.blending=THREE.NoBlending;}
 transparencyPass.value=3;renderer.setRenderTarget(frontSurface);renderer.setClearColor(0x000000,0);renderer.clear();renderer.render(scene,camera);
 frontDepth.value=frontSurface.depthTexture;
 for(const m of materials){m.transparent=true;m.depthWrite=false;m.blending=THREE.CustomBlending;m.blendEquation=THREE.AddEquation;m.blendSrc=THREE.OneFactor;m.blendDst=THREE.OneFactor;}
 transparencyPass.value=1;renderer.setRenderTarget(accumulation);renderer.setClearColor(0x000000,0);renderer.clear();renderer.render(scene,camera);
 for(const m of materials){m.blendSrc=THREE.ZeroFactor;m.blendDst=THREE.OneMinusSrcAlphaFactor;}
 transparencyPass.value=2;renderer.setRenderTarget(revealage);renderer.setClearColor(0xffffff,1);renderer.clear();renderer.render(scene,camera);
 renderer.setRenderTarget(null);renderer.render(compositeScene,compositeCamera);
 scene.background=background;transparencyPass.value=0;
}
function style(){const alpha=+$('alpha').value;for(const [id,obj] of objects){obj.visible=visibility.get(id)??true;for(const child of obj.children){child.visible=!child.isLineSegments||$('edges').checked;opacity(child.material,child.isLineSegments?Math.min(1,alpha*1.5):alpha);}}$('alpha-value').value=`${Math.round(alpha*100)}%`;}
function motion(){for(const row of rows){if(row.group)continue;const obj=objects.get(row.id),m=[...row.matrix];for(const [index,track] of Object.entries(row.tracks)){const p=track[Math.round(values[+index]*100)];for(let j=0;j<3;j++)m[12+j]+=p[j];}obj.matrix.fromArray(m);obj.matrixWorldNeedsUpdate=true;}}
async function switchSource(next){const request=++sourceRequest;status(`Loading ${next.toUpperCase()} assembly…`);try{const nextRows=await data(manifest.sources[next]);const built=await Promise.all(nextRows.filter(r=>!r.group).map(async r=>[r.id,await mesh(r.mesh)]));if(request!==sourceRequest){for(const [,o] of built)o.traverse(x=>x.material?.dispose());return;}const firstLoad=objects.size===0;clear(assembly);objects=new Map(built);rows=nextRows;if(firstLoad)collapsed=new Set(rows.filter(r=>r.group).map(r=>r.id));for(const row of rows){if(!visibility.has(row.id))visibility.set(row.id,row.visible);if(!row.group){const o=objects.get(row.id);o.matrixAutoUpdate=false;assembly.add(o);}}source=next;motion();style();tree();$('python').setAttribute('aria-pressed',String(next==='python'));$('dxf').setAttribute('aria-pressed',String(next==='dxf'));$('stp').setAttribute('aria-pressed',String(next==='stp'));if(firstLoad)fit(assembly);status(`${next.toUpperCase()} assembly · ${built.length} part instances`);}catch(e){fail(e);}}
function tree(){const root=$('tree');root.replaceChildren();for(const row of rows){if([...collapsed].some(id=>row.id.startsWith(id+'/')))continue;const div=document.createElement('div');div.className='tree-row';div.style.paddingLeft=`${row.depth*12}px`;const toggle=document.createElement('button');toggle.textContent=row.group?(collapsed.has(row.id)?'▸':'▾'):'';toggle.disabled=!row.group;toggle.setAttribute('aria-label',`${collapsed.has(row.id)?'Expand':'Collapse'} ${row.name}`);toggle.onclick=()=>{collapsed.has(row.id)?collapsed.delete(row.id):collapsed.add(row.id);tree();};div.append(toggle);const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';const descendants=row.group?rows.filter(r=>!r.group&&r.id.startsWith(row.id+'/')):[row];check.checked=descendants.every(r=>visibility.get(r.id));check.indeterminate=!check.checked&&descendants.some(r=>visibility.get(r.id));check.onchange=()=>{for(const d of descendants)visibility.set(d.id,check.checked);style();tree();};label.append(check,document.createTextNode(row.name));div.append(label);root.append(div);}}
function showTab(next){const previous=tab;tab=next;document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===tab)));$('assembly-panel').hidden=tab!=='assembly';$('files-panel').hidden=tab!=='files';$('viewport').hidden=!['assembly','files'].includes(tab);$('source-control').hidden=tab!=='assembly';$('wood-texture').hidden=tab!=='assembly'&&!(tab==='files'&&selectedFile&&['stp','step','stl'].includes(selectedFile.kind));$('comparison').hidden=tab!=='comparison';$('plans').hidden=tab!=='plans';$('parts').hidden=tab!=='parts';assembly.visible=tab==='assembly';fileGroup.visible=tab==='files'&&selectedFile&&['stp','step','stl'].includes(selectedFile.kind);$('file-toolbar').hidden=tab!=='files'||!selectedFile;$('document').hidden=tab!=='files'||selectedFile?.kind!=='csv';$('dxf-view').hidden=tab!=='files'||selectedFile?.kind!=='dxf';$('fit').hidden=tab==='files'&&!fileGroup.visible;if(['assembly','files'].includes(tab)){resize();if(fileGroup.visible||(tab==='assembly'&&previous==='files'))fit();}if(tab==='files'&&selectedFile?.kind==='dxf')drawDxf();}
function table(rows){const t=document.createElement('table');rows.forEach((row,i)=>{const tr=document.createElement('tr');for(const value of row){const cell=document.createElement(i?'td':'th');cell.textContent=value;tr.append(cell);}t.append(tr);});return t;}
function partsList(){
 const query=$('parts-filter').value.trim().toLowerCase(), all=manifest.parts||[];
 const parts=all.filter(p=>(p.name+' '+p.sheet).toLowerCase().includes(query));
 $('parts-count').textContent=`${parts.length} unique parts · ${parts.reduce((n,p)=>n+p.quantity,0)} pieces required`;
 const table=document.createElement('table');table.className='parts-table';table.setAttribute('aria-label','Manufacturing parts');
 const head=table.createTHead().insertRow();for(const label of ['Name','Sheet','Quantity required','Image','Can rotate','Preview','Downloads']){const th=document.createElement('th');th.scope='col';th.textContent=label;head.append(th);}
 const body=table.createTBody();
 for(const p of parts){const row=body.insertRow(),name=document.createElement('th');name.scope='row';name.textContent=p.name;row.append(name);
 row.insertCell().textContent=p.sheet;const quantity=row.insertCell();quantity.textContent=p.quantity;quantity.className='part-quantity';
 const img=document.createElement('img');img.src=p.thumbnail;img.alt=p.name+' preview';img.loading='lazy';img.width=144;img.height=88;row.insertCell().append(img);
 row.insertCell().textContent=p.canRotate?'Yes':'No';
 const previews=document.createElement('div');previews.className='part-downloads';for(const kind of ['stp','stl','dxf']){const file=manifest.files.find(f=>f.url===p.downloads[kind]);const button=document.createElement('button');button.type='button';button.textContent=kind.toUpperCase();button.setAttribute('aria-label',`Preview ${p.name} as ${kind.toUpperCase()}`);button.disabled=!file;button.onclick=()=>{$('filter').value='';openFile(file);};previews.append(button);}row.insertCell().append(previews);
 const links=document.createElement('div');links.className='part-downloads';for(const kind of ['stp','stl','dxf']){const a=document.createElement('a');a.href=p.downloads[kind];a.download=p.downloads[kind].split('/').pop();a.textContent=kind.toUpperCase();a.setAttribute('aria-label',`Download ${p.name} as ${kind.toUpperCase()}`);links.append(a);}
 row.insertCell().append(links);}
 if(!parts.length){const cell=body.insertRow().insertCell();cell.colSpan=7;cell.textContent='No parts match your search.';}
 $('parts-table-wrap').replaceChildren(table);
}
function files(){const filter=$('filter').value.toLowerCase();const list=manifest.files.filter(f=>f.name.toLowerCase().includes(filter));$('file-count').textContent=`${list.length} exported files`;$('file-list').replaceChildren();for(const f of list){const button=document.createElement('button');button.textContent=f.name;button.classList.toggle('selected',selectedFile===f);button.onclick=()=>openFile(f);$('file-list').append(button);}}
async function openFile(f){const request=++fileRequest;status(`Loading ${f.name}…`);try{const payload=await data(f.preview);let object;if(['stp','step','stl'].includes(f.kind))object=await mesh(f.preview);if(request!==fileRequest){object?.traverse(o=>o.material?.dispose());return;}selectedFile=f;clear(fileGroup);if(object){fileGroup.add(object);fileOpacity();}else if(f.kind==='dxf')setupDxf(payload);else $('document').replaceChildren(table(payload));$('download').href=f.url;$('download').download=f.name.split('/').pop();$('file-alpha').parentElement.hidden=!object;files();showTab('files');status(f.name);}catch(e){fail(e);}}
function fileOpacity(){fileGroup.traverse(o=>{if(o.material){opacity(o.material,+$('file-alpha').value);}});}
// DXF layers share one viewBox; wheel zoom preserves the world point under the pointer.
let dxf=null, svg=null, full=null, view=null, drag=null;
function setupDxf(payload){dxf=payload;full=payload.viewBox.split(/\s+/).map(Number);view=[...full];const ns='http://www.w3.org/2000/svg';svg=document.createElementNS(ns,'svg');svg.setAttribute('aria-label','DXF drawing');svg.setAttribute('role','img');$('layers').replaceChildren();for(const layer of payload.layers){const parsed=new DOMParser().parseFromString(layer.svg,'image/svg+xml');const nested=document.importNode(parsed.documentElement,true);nested.setAttribute('x',full[0]);nested.setAttribute('y',full[1]);nested.setAttribute('width',full[2]);nested.setAttribute('height',full[3]);svg.append(nested);const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=true;check.onchange=()=>nested.style.display=check.checked?'':'none';label.append(check,document.createTextNode(layer.name));$('layers').append(label);} $('drawing').replaceChildren(svg);drawDxf();}
function drawDxf(){if(!svg)return;svg.setAttribute('viewBox',view.join(' '));$('zoom-value').textContent=`${Math.round(full[2]/view[2]*100)}%`;requestAnimationFrame(()=>{if(!$('dxf-view').hidden){const m=svg.getScreenCTM();if(!m)return;const pxPerMm=Math.hypot(m.a,m.b)*dxf.unitsPerMm;const target=100/pxPerMm;const power=10**Math.floor(Math.log10(target));const nice=[1,2,5,10].filter(n=>n*power<=target).pop()*power;$('scale-bar').style.width=`${nice*pxPerMm}px`;$('scale-label').textContent=`${Number(nice.toPrecision(4))} mm`;}});}
function point(x,y){return new DOMPoint(x,y).matrixTransform(svg.getScreenCTM().inverse());}
function zoom(factor,x,y){if(!svg)return;const old=view[2];const width=Math.min(full[2]*4,Math.max(full[2]/64,old*factor));factor=width/old;const p=x===undefined?{x:view[0]+view[2]/2,y:view[1]+view[3]/2}:point(x,y);view=[p.x+(view[0]-p.x)*factor,p.y+(view[1]-p.y)*factor,width,view[3]*factor];drawDxf();}
$('drawing').addEventListener('wheel',e=>{if(!svg)return;e.preventDefault();zoom(Math.exp(Math.max(-100,Math.min(100,e.deltaY*(e.deltaMode===1?16:1)))*.002),e.clientX,e.clientY);},{passive:false});
$('drawing').onpointerdown=e=>{if(!svg)return;drag=point(e.clientX,e.clientY);$('drawing').setPointerCapture(e.pointerId);};$('drawing').onpointermove=e=>{if(!drag)return;const p=point(e.clientX,e.clientY);view[0]+=drag.x-p.x;view[1]+=drag.y-p.y;drawDxf();};$('drawing').onpointerup=$('drawing').onpointercancel=()=>drag=null;
$('zoom-in').onclick=()=>zoom(1/1.25);$('zoom-out').onclick=()=>zoom(1.25);$('zoom-fit').onclick=()=>{view=[...full];drawDxf();};for(const [id,checked] of [['layers-all',true],['layers-none',false]])$(id).onclick=()=>{for(const c of $('layers').querySelectorAll('input')){c.checked=checked;c.onchange();}};
function resize(){const r=$('canvas').getBoundingClientRect();if(r.width&&r.height){renderer.setSize(r.width,r.height);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();}drawDxf();}new ResizeObserver(resize).observe($('viewport'));
renderer.setAnimationLoop(()=>{if(['assembly','files'].includes(tab)&&!document.hidden){controls.update();renderView();}});
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));$('fit').onclick=()=>fit();$('wood-texture').onclick=()=>{walnutEnabled.value=1-walnutEnabled.value;$('wood-texture').setAttribute('aria-pressed',String(!!walnutEnabled.value));};$('alpha').oninput=style;$('edges').onchange=style;$('file-alpha').oninput=fileOpacity;$('filter').oninput=files;$('parts-filter').oninput=partsList;$('python').onclick=()=>{if(source!=='python')switchSource('python');};$('dxf').onclick=()=>{if(source!=='dxf')switchSource('dxf');};$('stp').onclick=()=>{if(source!=='stp')switchSource('stp');};$('expand').onclick=()=>{collapsed.clear();tree();};$('collapse').onclick=()=>{collapsed=new Set(rows.filter(r=>r.group).map(r=>r.id));tree();};
try{manifest=await json('manifest.json?v=gap-17');values=[...manifest.values];$('alpha').value=1;$('build-info').textContent=`Published ${new Date(manifest.built).toLocaleString()} · design ${manifest.modelSha256.slice(0,12)} · generated locally, viewed entirely in your browser`;
manifest.labels.forEach((name,i)=>{const label=document.createElement('label'),out=document.createElement('output'),input=document.createElement('input');input.type='range';input.min=0;input.max=1;input.step=.01;input.value=values[i];out.value=`${Math.round(values[i]*100)}%`;input.setAttribute('aria-label',name);input.oninput=()=>{values[i]=+input.value;out.value=`${Math.round(values[i]*100)}%`;motion();};label.append(document.createTextNode(name),out,input);$('sliders').append(label);});
partsList();files();for(const f of manifest.files.filter(f=>f.kind==='csv')){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=f.name;details.append(summary,table(await data(f.preview)));$('plans').append(details);}for(const url of manifest.plans){const img=document.createElement('img');img.src=url;img.alt=url.split('/').pop();img.loading='lazy';$('plans').append(img);}const report=await fetch('comparison/comparison.txt');if(!report.ok)throw Error('Cannot load comparison report');$('report').textContent=await report.text();await switchSource('python');}catch(e){fail(e);}
