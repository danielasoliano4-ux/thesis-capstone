const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmailOtp } = require('./email-otp');
class HttpsError extends Error { constructor(code, message, details) { super(message); this.code=code; this.details=details; } }
function fixture({ mailFails = false } = {}) {
 let time=1000000, sequence=123456, updates=0, queue=Promise.resolve();
 const documents=new Map(), emails=[];
 const user={uid:'one',email:'one@example.com',emailVerified:false};
 const handlers=createEmailOtp({
  db:{collection:()=>({doc:id=>({id})}),runTransaction:callback=>{
   const operation=queue.then(()=>callback({get:async ref=>({data:()=>documents.get(ref.id)}),set:(ref,value)=>documents.set(ref.id,value),update:(ref,value)=>documents.set(ref.id,{...documents.get(ref.id),...value})}));
   queue=operation.catch(()=>{});return operation;
  }},
  auth:{getUser:async()=>({...user}),updateUser:async(uid,data)=>{updates++;Object.assign(user,data);}},
  HttpsError,secret:()=> 'test-secret',now:()=>time,generateCode:()=>String(sequence++),
  sendEmail:async(email,code)=>{if(mailFails)throw new Error('mail error');emails.push({email,code});}
 });
 return {documents,user,emails,updates:()=>updates,advance:ms=>{time+=ms;},
  send:()=>handlers.requestCode({auth:{uid:'one'},data:{email:'attacker@example.com'}}),
  verify:code=>handlers.verifyCode({auth:{uid:'one'},data:{code}}),handlers};
}
test('code email is bound to authenticated account; database has HMAC not plaintext',async()=>{
 const f=fixture();await f.send();
 assert.deepEqual(f.emails,[{email:'one@example.com',code:'123456'}]);
 assert.ok(!JSON.stringify([...f.documents.values()]).includes('123456'));
 await f.verify('123456');assert.equal(f.user.emailVerified,true);
 await f.verify('123456');assert.equal(f.updates(),1);
});
test('resend waits sixty seconds and invalidates the older code',async()=>{
 const f=fixture();await f.send();
 await assert.rejects(f.send(),e=>e.code==='resource-exhausted'&&e.details.retryAfterMs===60000);
 f.advance(60000);await f.send();
 await assert.rejects(f.verify('123456'),{code:'failed-precondition'});
 await f.verify(f.emails[1].code);assert.equal(f.user.emailVerified,true);
});
test('expired codes are rejected',async()=>{
 const f=fixture();await f.send();f.advance(300000);
 await assert.rejects(f.verify('123456'),{code:'failed-precondition'});assert.equal(f.updates(),0);
});
test('five incorrect codes exhaust verification attempts, including parallel attempts',async()=>{
 const f=fixture();await f.send();
 await Promise.allSettled(Array.from({length:9},()=>f.verify('000000')));
 assert.equal(f.documents.get('one').attempts,5);
 await assert.rejects(f.verify('123456'),{code:'failed-precondition'});assert.equal(f.updates(),0);
});
test('only five emails per hour; changing the email invalidates existing code',async()=>{
 const f=fixture();for(let i=0;i<5;i++){await f.send();f.advance(60000);}
 await assert.rejects(f.send(),{code:'resource-exhausted'});
 f.user.email='changed@example.com';await assert.rejects(f.verify(f.emails[4].code),{code:'failed-precondition'});
});
test('unauthenticated and malformed requests are rejected',async()=>{
 const f=fixture();await assert.rejects(f.handlers.requestCode({data:{}}),{code:'unauthenticated'});
 await assert.rejects(f.verify('12'),{code:'invalid-argument'});assert.equal(f.updates(),0);
});
test('email delivery failure is surfaced and remains rate limited',async()=>{
 const f=fixture({mailFails:true});await assert.rejects(f.send(),{code:'unavailable'});
 await assert.rejects(f.send(),{code:'resource-exhausted'});assert.equal(f.updates(),0);
});
test('concurrent matching codes apply verification only once',async()=>{
 const f=fixture();await f.send();await Promise.allSettled([f.verify('123456'),f.verify('123456')]);assert.equal(f.updates(),1);
});