const test=require('node:test'),assert=require('node:assert/strict');
const {resolveIntakeContext}=require('./intake-context');
const patient={resident_uid:'r',vaccination_session_id:'same'};
const details={...patient,date_of_birth:'2000-05-01',patient_sex:'Female',bite_type:'Scratch',wound_washed:'Yes',animal_type:'Monkey',bite_body_part:'Left leg',bite_date:'2026-09-01',patient_category:'Category II'};
test('followups reuse course intake even across clinics and ignore unrelated patients',()=>{
 const result=resolveIntakeContext({...patient,id:'next'},[{...details,id:'old',clinic_id:'previous'},{...details,resident_uid:'other',patient_sex:'Male'}]);
 assert.equal(result.mode,'review');assert.equal(result.defaults.animal_type,'Monkey');assert.equal(result.defaults.patient_sex,'Female');assert.deepEqual(result.missingFields,[]);
});
test('new incident reuses demographics only',()=>{
 const result=resolveIntakeContext({...patient,vaccination_session_id:'new'},[details]);
 assert.equal(result.mode,'new_exposure');assert.equal(result.defaults.patient_sex,'Female');assert.equal(result.defaults.bite_type,undefined);assert.equal(result.defaults.bite_date,undefined);
});
test('first patient uses profile details and leaves exposure empty',()=>{
 const result=resolveIntakeContext(patient,[],{date_of_birth:'2001-01-01',gender:'Male'});
 assert.equal(result.mode,'new_patient');assert.equal(result.defaults.patient_sex,'Male');assert.equal(result.defaults.bite_body_part,undefined);
});
test('legacy history and incomplete records fill fields individually without inventing data',()=>{
 const result=resolveIntakeContext({resident_uid:'r'},[{resident_uid:'r',course_intake_data:{bite_type:'Bite',patient_category:'Category III'},patient_sex:'Male'}]);
 assert.equal(result.mode,'review');assert.equal(result.defaults.bite_type,'Bite');assert.ok(result.missingFields.includes('date_of_birth'));
});
test('latest same course values win but older other course exposure is excluded',()=>{
 const result=resolveIntakeContext(patient,[{...details,recorded_at:'2026-09-01'},{...details,recorded_at:'2026-09-02',bite_body_part:'Right hand'},{...details,vaccination_session_id:'old',recorded_at:'2026-09-03',bite_type:'Bite'}]);
 assert.equal(result.defaults.bite_body_part,'Right hand');assert.equal(result.defaults.bite_type,'Scratch');
});
