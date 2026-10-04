import { notifyDialog } from './app-dialogs.js';
import { protectPage } from './role-guard.js';
import {auth,db,fetchUserProfile,onAuthStateChanged} from './firebase.js';
import {collection,query,where,onSnapshot} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import {appointmentDeadline} from './booking-status.js';
import {markArrivalAndOpenIntake,openIntake} from './appointment-intake.js';
protectPage('clinic_staff');
const $=id=>document.getElementById(id);
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
let rows=[],loaded=false,unsubscribe,generation=0;
const busy=new Set();
function render(){
 if(!loaded)return;
 const date=$('confirmedDate').value,search=$('confirmedSearch').value.trim().toLowerCase();
 const items=rows.filter(item=>['confirmed','in_progress'].includes(item.status)&&(!date||item.preferred_date===date)&&String(item.resident_name||'').toLowerCase().includes(search)).sort((a,b)=>String(a.preferred_date).localeCompare(String(b.preferred_date))||appointmentDeadline(a)-appointmentDeadline(b));
 $('confirmedStatus').textContent=items.length?items.length+' confirmed / in-progress appointment'+(items.length===1?'':''):'No confirmed appointments match these filters.';
 $('confirmedList').replaceChildren();
 for(const item of items){
  const card=document.createElement('article');card.className='confirmed-card';
  const badge=document.createElement('span');badge.className='confirmed-status';badge.textContent=item.status==='confirmed'?'Confirmed':'Arrived / In progress';
  const heading=document.createElement('h3');heading.textContent=item.resident_name||'Resident';
  const details=document.createElement('p');details.textContent=[item.preferred_date,item.preferred_time,item.dose_label||'Dose 1',item.clinic_name].filter(Boolean).join(' | ');
  const actions=document.createElement('div');actions.className='confirmed-actions';
  const link=document.createElement('a');link.href='patient-tracking.html?appointment='+encodeURIComponent(item.id);link.textContent=item.intake_completed_at?'View details / Complete dose':'View details';actions.append(link);
  if(item.status==='confirmed'||!item.intake_completed_at){
   const button=document.createElement('button');button.type='button';button.textContent=item.status==='confirmed'?'Mark Arrived':'Complete Intake';
   const deadline=appointmentDeadline(item);
   const allowed=item.status!=='confirmed'||(item.preferred_date<=today()&&Number.isFinite(deadline)&&Date.now()<deadline);
   button.disabled=busy.has(item.id)||!allowed;
   if(!allowed){const note=document.createElement('p');note.textContent=item.preferred_date>today()?'Arrival opens on the appointment date.':'The 90-minute arrival window has ended.';card.append(note);}
   button.onclick=async()=>{if(busy.has(item.id))return;busy.add(item.id);button.disabled=true;try{if(item.status==='confirmed')await markArrivalAndOpenIntake(item.id,item);else openIntake(item.id,item);}catch(error){notifyDialog(error.message||'Could not update appointment.');}finally{busy.delete(item.id);render();}};
   actions.prepend(button);
  }
  card.prepend(badge,heading,details);card.append(actions);$('confirmedList').append(card);
 }
}
$('confirmedSearch').addEventListener('input',render);$('confirmedDate').addEventListener('change',render);
$('confirmedToday').onclick=()=>{$('confirmedDate').value=today();render();};
$('confirmedAll').onclick=()=>{$('confirmedDate').value='';$('confirmedSearch').value='';render();};
onAuthStateChanged(auth,async user=>{
 const run=++generation;unsubscribe?.();loaded=false;rows=[];$('confirmedList').replaceChildren();
 if(!user){location.href='login.html';return;}
 const profile=await fetchUserProfile(user.uid);if(run!==generation)return;
 if(profile?.role!=='clinic_staff'||profile.is_active!==true||(profile.approval_status||'approved')!=='approved'){$('confirmedStatus').textContent='An approved clinic staff account is required.';return;}
 unsubscribe=onSnapshot(query(collection(db,'appointments'),where('clinic_id','==',profile.clinic_id||user.uid)),snapshot=>{if(run!==generation)return;rows=snapshot.docs.map(doc=>({...doc.data(),id:doc.id}));loaded=true;render();},()=>{loaded=false;$('confirmedList').replaceChildren();$('confirmedStatus').textContent='Could not load appointments. Check your connection and reload.';});
});
setInterval(render,30000);
