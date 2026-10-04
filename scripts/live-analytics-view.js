const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function renderLiveCaptions(data={}) {
 const trend=document.getElementById('caseTrendChart'), age=document.getElementById('ageGroupChart');
 const year=data.year || new Date().getFullYear();
 const counts=Array.from({length:12},(_,i)=>Number(data.monthlyCases?.[i])||0), peak=Math.max(...counts);
 if(trend){
 trend.parentElement.querySelector('h4').textContent='Case Trend (Jan-Dec '+year+')';
 trend.parentElement.querySelector('.trend-labels').innerHTML=months.map(m=>'<span class="trend-label">'+m+'</span>').join('');
 trend.parentElement.querySelector('p').textContent=peak ? months.filter((_,i)=>counts[i]===peak).join(', ')+' peak: '+peak+' cases - highest monthly count in '+year : 'No cases recorded in '+year+'.';
 }
 if(age){
 const groups=Array.from({length:5},(_,i)=>Number(data.ageGroups?.[i])||0), total=groups.reduce((a,b)=>a+b,0), highest=Math.max(...groups), labels=['0-9','10-19','20-39','40-59','60+'];
 age.parentElement.querySelector('h4').textContent='Cases by Age Group ('+year+')';
 age.parentElement.querySelector('p').textContent=total ? 'Highest recorded age group: '+labels.filter((_,i)=>groups[i]===highest).join(', ')+' ('+Math.round(highest/total*100)+'% of cases with known age).' : 'No age data recorded for '+year+'.';
 }
}
