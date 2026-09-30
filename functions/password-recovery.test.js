const test = require('node:test');
const assert = require('node:assert/strict');
const { createPasswordRecovery } = require('./password-recovery');
class HttpsError extends Error { constructor(code,message) {super(message);this.code=code;} }
function fixture() {
 let time=1000000, queue=Promise.resolve(), updates=0, revokes=0;
 const docs=new Map(), emails=[];
 const user={uid:'one',email:'one@example.com',displayName:'Test User',tokensValidAfterTime:'original'};
 const ref=(name,id)=>({id,get:async()=>({data:()=>docs.get(name+'/'+id)}),set:async value=>docs.set(name+'/'+id,value),key:name+'/'+id});
 const db={collection:name=>({doc:id=>ref(name,id),where:(field,op,value)=>({limit:()=>({get:async()=>({docs: value==='09123456789'||value==='tester'?[{id:'one'}]:[]})})})}),runTransaction:fn=>{
  const result=queue.then(()=>fn({get:r=>r.get(),set:(r,v)=>docs.set(r.key,v),update:(r,v)=>docs.set(r.key,{...docs.get(r.key),...v})})); queue=result.catch(()=>{});return result;
 }};
 const auth={getUserByEmail:async email=>{if(email!==user.email)throw {code:'auth/user-not-found'};return {...user};},getUser:async()=>({...user}),updateUser:async(_,data)=>{updates++;user.tokensValidAfterTime='changed';},revokeRefreshTokens:async()=>{revokes++;}};
 const h=createPasswordRecovery({db,auth,HttpsError,secret:()=> 'test-secret',sendEmail:async(email,code)=>emails.push({email,code}),now:()=>time});
 const req=data=>({data,rawRequest:{ip:'test'}});
 return {docs,emails,user,h,req,advance:ms=>time+=ms,updates:()=>updates,revokes:()=>revokes,
 find:identifier=>h.findAccount(req({identifier})),send:id=>h.sendCode(req({recoveryId:id,channel:'email'})),verify:(id,code)=>h.verifyCode(req({recoveryId:id,code})),reset:(id,grant)=>h.resetPassword(req({recoveryId:id,resetToken:grant,password:'Long secure password',confirmPassword:'Long secure password'}))};
}
async function begin(f) {const {recoveryId}=await f.find('one@example.com');await f.send(recoveryId);return recoveryId;}
test('email, phone and username resolve a masked account',async()=>{for(const value of ['ONE@example.com','+639123456789','tester']){const f=fixture();const result=await f.find(value);assert.equal(result.account,'T***');assert.equal(result.channels[0].label,'Email: o***@example.com');}});
test('code grants one-time password reset and revokes sessions',async()=>{const f=fixture(),id=await begin(f);assert.ok(!JSON.stringify([...f.docs.values()]).includes(f.emails[0].code));const {resetToken}=await f.verify(id,f.emails[0].code);await f.reset(id,resetToken);assert.equal(f.updates(),1);assert.equal(f.revokes(),1);assert.ok(f.docs.has('_session_revocations/one'));await assert.rejects(f.reset(id,resetToken));});
test('wrong codes exhaust after five attempts',async()=>{const f=fixture(),id=await begin(f);for(let n=0;n<5;n++)await assert.rejects(f.verify(id,'000000'));await assert.rejects(f.verify(id,f.emails[0].code));assert.equal(f.updates(),0);});
test('expired code and expired reset grants fail',async()=>{const f=fixture(),id=await begin(f);f.advance(300001);await assert.rejects(f.verify(id,f.emails[0].code));const g=fixture(),other=await begin(g),{resetToken}=await g.verify(other,g.emails[0].code);g.advance(300001);await assert.rejects(g.reset(other,resetToken));});
test('resends are rate limited and replace old code',async()=>{const f=fixture(),id=await begin(f);await assert.rejects(f.send(id),{code:'resource-exhausted'});const digest=f.docs.get('_password_recovery/'+id).digest;f.advance(60001);await f.send(id);assert.equal(f.emails.length,2);assert.equal(f.docs.get('_password_recovery/'+id).attempts,0);});
test('unverified requests, forged grants and concurrent reuse cannot reset',async()=>{const f=fixture(),id=await begin(f);await assert.rejects(f.reset(id,'a'.repeat(64)));const {resetToken}=await f.verify(id,f.emails[0].code);await assert.rejects(f.reset(id,'b'.repeat(64)));const results=await Promise.allSettled([f.reset(id,resetToken),f.reset(id,resetToken)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.updates(),1);});
test('changed account email invalidates recovery',async()=>{const f=fixture(),id=await begin(f),{resetToken}=await f.verify(id,f.emails[0].code);f.user.email='new@example.com';await assert.rejects(f.reset(id,resetToken));assert.equal(f.updates(),0);});
test('unsupported channels and password mismatch are rejected',async()=>{const f=fixture(),id=await begin(f);await assert.rejects(f.h.sendCode(f.req({recoveryId:id,channel:'sms'})),{code:'invalid-argument'});await assert.rejects(f.h.resetPassword(f.req({recoveryId:id,password:'short',confirmPassword:'different'})),{code:'invalid-argument'});});
