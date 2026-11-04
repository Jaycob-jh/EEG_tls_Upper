"""Compare available Watch sleep summaries with replay sessions; never score Watch as truth."""
import argparse, json, zipfile, xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime
from collections import defaultdict

p=argparse.ArgumentParser();p.add_argument('archive',type=Path);p.add_argument('batch',type=Path);a=p.parse_args()
report=json.loads((a.batch/'results.json').read_text())
sessions=[r for r in report['files'] if r.get('startedAt') and r.get('endedAt')]
windows=[(datetime.fromisoformat(r['startedAt']),datetime.fromisoformat(r['endedAt'])) for r in sessions]
records=[]
with zipfile.ZipFile(a.archive) as archive:
    xmls=[n for n in archive.namelist() if n.endswith('.xml') and not n.endswith('export_cda.xml')]
    if len(xmls)!=1:raise ValueError('无法确定健康导出的睡眠 XML')
    with archive.open(xmls[0]) as stream:
        iterator=ET.iterparse(stream,events=('start','end'));_,root=next(iterator)
        for event,element in iterator:
            if event!='end':continue
            if element.tag=='Record' and element.get('type')=='HKCategoryTypeIdentifierSleepAnalysis' and 'watch' in element.get('sourceName','').lower():
                start=datetime.strptime(element.get('startDate'),'%Y-%m-%d %H:%M:%S %z');end=datetime.strptime(element.get('endDate'),'%Y-%m-%d %H:%M:%S %z')
                if any(start<right and end>left for left,right in windows):
                    records.append({'source':element.get('sourceName'),'stage':element.get('value','').replace('HKCategoryValueSleepAnalysis',''),'start':start,'end':end})
            element.clear();root.clear()
rows=[]
for session,(left,right) in zip(sessions,windows):
    selected=sorted([dict(r,start=max(left,r['start']),end=min(right,r['end'])) for r in records if r['start']<right and r['end']>left],key=lambda r:r['start'])
    unique=[];seen=set()
    for r in selected:
        key=(r['source'],r['stage'],r['start'],r['end'])
        if key not in seen:unique.append(r);seen.add(key)
    overlap=any(prev['end']>current['start'] for prev,current in zip(unique,unique[1:]))
    minutes=defaultdict(float)
    if not overlap:
        for r in unique:minutes[r['stage']]+=(r['end']-r['start']).total_seconds()/60
    rows.append({'id':session['id'],'records':len(unique),'status':'overlap_unresolved' if overlap else 'available' if unique else 'not_available',
        'stageMinutes':dict(minutes),'alignment':'session_wall_window_only_no_epoch_agreement',
        'deepIntervals':[{'start':r['start'].isoformat(),'end':r['end'].isoformat()} for r in unique if r['stage']=='AsleepDeep']})
result={'archive':str(a.archive),'sessions':rows,'limitations':['手表是另一套算法的估计，不是人工睡眠标签。','旧 EDF 缺少逐样本时间；这里只比较同一次记录的时段汇总，不计算逐片段准确率。']}
(a.batch/'watch-comparison.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({'sessions':len(rows),'matched':sum(r['status']=='available' for r in rows),'unresolved':sum(r['status']=='overlap_unresolved' for r in rows)},ensure_ascii=False))
