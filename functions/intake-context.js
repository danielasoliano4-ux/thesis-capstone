'use strict';
const exposureFields=['bite_type','wound_washed','animal_type','bite_body_part','bite_date','patient_category'];
const patientFields=['date_of_birth','patient_sex'];
function resolveIntakeContext(appointment, records, profile={}) {
 const session=row=>row.vaccination_session_id||'legacy';
 const time=row=>row.recorded_at?.toMillis?.()||row.created_at?.toMillis?.()||Date.parse(row.recorded_at||row.created_at||row.preferred_date||'')||0;
 const history=records.filter(row=>row.resident_uid===appointment.resident_uid && (!appointment.id || row.id!==appointment.id)).sort((a,b)=>time(b)-time(a));
 const flatten=row=>({...row,...(row.course_intake_data||{})});
 const current=flatten(appointment), same=history.filter(row=>session(row)===session(appointment)).map(flatten), all=history.map(flatten), defaults={};
 const pick=(field,sources)=>sources.find(row=>typeof row[field]==='string' && row[field].trim())?.[field]?.trim();
 for(const field of patientFields){ const value=pick(field,[current,...same,...all,{...profile,patient_sex:profile.patient_sex||profile.gender||profile.sex}]); if(value)defaults[field]=value; }
 for(const field of exposureFields){ const value=pick(field,[current,...same]); if(value)defaults[field]=value; }
 const sameExposure=exposureFields.some(field=>defaults[field]);
 return {defaults,mode:sameExposure?'review':history.length?'new_exposure':'new_patient',missingFields:[...exposureFields,...patientFields].filter(field=>!defaults[field])};
}
module.exports={resolveIntakeContext};
