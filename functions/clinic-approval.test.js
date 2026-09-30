const test=require('node:test'),assert=require('node:assert/strict');
const {createClinicApproval}=require('./clinic-approval');
class HttpsError extends Error {constructor(code,message){super(message);this.code=code;}}
function fixture(options={}) {
 const rows=new Map([['users/admin',{role:options.role||'admin'}],['users/staff',{role:'clinic_staff',approval_status:'pending',clinic_name:'Clinic',clinic_address:'12 Main Street',clinic_barangay:'Banlic',clinic_lat:14.27,clinic_lng:121.12,phone:'123'}]]);
 let calls=0;
 const ref=path=>({path,get:async()=>({exists:rows.has(path),data:()=>rows.get(path)})});
 const db={collection:name=>({doc:id=>ref(name+'/'+id)}),runTransaction:async fn=>{const writes=[];const result=await fn({get:r=>r.get(),set:(r,v)=>writes.push(()=>rows.set(r.path,{...rows.get(r.path),...v})),update:(r,v)=>writes.push(()=>rows.set(r.path,{...rows.get(r.path),...v}))});writes.forEach(write=>write());return result;}};
 const handler=createClinicApproval({db,HttpsError,timestamp:()=> 'time',geocode:async()=>{calls++;if(options.fail)throw new HttpsError('unavailable','lookup failed');return {lat:14.25,lng:121.13,city:'Cabuyao',country:'PH',provider:'test',precise:!options.imprecise};}});
 return {rows,calls:()=>calls,run:(approved=true, manualLocation)=>handler({auth:{uid:'admin',token:{secure_login:true}},data:{uid:'staff',approved,manualLocation}})};
}
test('approval publishes the exact registration pin without geocoding',async()=>{const f=fixture({fail:true});await f.run();assert.equal(f.rows.get('clinics/staff').lat,14.27);assert.equal(f.rows.get('clinics/staff').lng,121.12);assert.deepEqual(f.rows.get('clinics/staff').location,{latitude:14.27,longitude:121.12});assert.equal(f.rows.get('users/staff').clinic_id,'staff');assert.equal(f.rows.get('users/staff').approval_status,'approved');await f.run();assert.equal(f.calls(),0);});
test('denial does not publish a clinic',async()=>{const f=fixture();await f.run(false);assert.equal(f.calls(),0);assert.equal(f.rows.has('clinics/staff'),false);});
test('unauthorized and incomplete registrations cannot activate',async()=>{for(const config of [{role:'resident'},{missing:true}]){const f=fixture(config);if(config.missing)delete f.rows.get('users/staff').clinic_barangay;await assert.rejects(f.run());assert.equal(f.rows.get('users/staff').approval_status,'pending');assert.equal(f.rows.has('clinics/staff'),false);}});
test('admin cannot supply a clinic pin during approval',async()=>{const f=fixture();await assert.rejects(f.run(true,{lat:14.27,lng:121.12,confirmed:true}));assert.equal(f.rows.has('clinics/staff'),false);});

test('missing and invalid registration pins cannot be approved',async()=>{for(const pin of [undefined,NaN,0,'14.27',91]){const f=fixture();f.rows.get('users/staff').clinic_lat=pin;await assert.rejects(f.run());assert.equal(f.rows.has('clinics/staff'),false);assert.equal(f.rows.get('users/staff').approval_status,'pending');}});
test('denial remains possible for legacy registrations without a pin',async()=>{const f=fixture();delete f.rows.get('users/staff').clinic_lat;await f.run(false);assert.equal(f.rows.get('users/staff').approval_status,'denied');});
