const test=require('node:test'),assert=require('node:assert/strict');
const {selectClinicLocation,createClinicGeocoder}=require('./clinic-geocoder');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const row={lat:'14.25',lon:'121.13',osm_type:'node',osm_id:1,place_rank:30,type:'clinic',address:{city:'Cabuyao',country_code:'ph',suburb:'Banlic'}};
const input={address:'12 Main Street',barangay:'Banlic',city:'Cabuyao',province:'Laguna'};
test('Nominatim result must identify one building or clinic in the requested barangay',()=>{
 assert.equal(selectClinicLocation([row],input,HttpsError).lat,14.25);
 for(const rows of [[],[row,{...row,osm_id:2}],[{...row,place_rank:16}],[{...row,address:{...row.address,suburb:'Pulo'}}],[{...row,address:{...row.address,city:'Manila'}}]])assert.throws(()=>selectClinicLocation(rows,input,HttpsError));
});
test('lookup identifies app, caches results and rate limits uncached requests',async()=>{
 let time=1000,calls=0;const rows=new Map();
 const ref=path=>({get:async()=>({data:()=>rows.get(path)}),set:async value=>rows.set(path,value),path});
 const db={collection:name=>({doc:id=>ref(name+'/'+id)}),runTransaction:async fn=>fn({get:r=>r.get(),set:(r,v)=>rows.set(r.path,v)})};
 const geocode=createClinicGeocoder({db,HttpsError,now:()=>time,fetchImpl:async(url,options)=>{calls++;assert.match(options.headers['User-Agent'],/AntiRabiesLocator/);assert.equal(new URL(url).searchParams.get('countrycodes'),'ph');return{ok:true,json:async()=>[row]};}});
 await geocode(input);await geocode(input);assert.equal(calls,1);
 await assert.rejects(geocode({...input,address:'13 Main Street'}),{code:'resource-exhausted'});
 time+=1101;await geocode({...input,address:'13 Main Street'});assert.equal(calls,2);
});
