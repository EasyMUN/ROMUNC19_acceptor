import fetch from 'node-fetch';

import bank from './bank';

import Koa from 'koa';
import Bodyparser from 'koa-bodyparser';

import und from 'underscore';

import { key, base } from './config';

async function parseResp(resp) {
  if(resp.status === 204) return null;
  else if(resp.status >= 400)
    throw resp.status;
  else if(resp.headers.get('Content-Type').indexOf('application/json') === 0)
    return resp.json();
  else return resp.text();
}

async function get(path) {
  const resp = await fetch(`${base}${path}`, {
    headers: {
      'Authorization': `Bearer ${key}`,
    },
  });

  return parseResp(resp);
}

async function post(path, body, method = 'POST') {
  const resp = await fetch(`${base}${path}`, {
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },

    method,
    body: JSON.stringify(body),
  });

  return parseResp(resp);
}

function fetchJCCSBank(region, focus, count) {
  const rb = bank.JCCS.regions[region];
  if(!rb) return und.sample(bank.JCCS.SC, count);
  if(Array.isArray(rb)) return und.sample(rb, count);

  const bucket = rb[focus] || [];
  if(bucket.length < count) {
    // Select the full bucket
    const others = Object.keys(rb).filter(e => e !== focus).map(k => rb[k]).reduce((acc, e) => acc.concat(e), []);
    const left = count - bucket.length;
    const rest = und.sample(others, left);

    return bucket.concat(rest);
  } else
    return und.sample(rb[focus], count);
}

async function acceptUser(user, reg, stage) {
  // Already after this stage
  if(stage !== 'reg') return false;

  const target = reg[0];
  let probs = null;

  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 7);

  if(target.committee !== 'JCCS') {
    // Just sample two
    const easier = und.sample(bank[target.committee].easy, 3);
    const harder = und.sample(bank[target.committee].hard, 2);
    probs = [...easier, ...harder];
  } else {
    probs = [];

    if(target.payload.MPC)
      probs.push(und.sample(bank[target.committee].MPC));
    if(target.payload.SC)
      probs.push(und.sample(bank[target.committee].SC));

    const primaryRegion = Object.keys(target.payload['1']).find(e => target.payload['1'][e] === 1).substr(0, 2);
    const secondaryRegion = Object.keys(target.payload['1']).find(e => target.payload['1'][e] === 2).substr(0, 2);
    const primaryFocus = Object.keys(target.payload['2']).find(e => target.payload['2'][e] === 1).substr(0, 2);

    const primaryCount = Math.ceil((5 - probs.length) / 2)
    const secondaryCount = 5 - probs.length - primaryCount;

    probs = [
      ...probs,
      ...fetchJCCSBank(primaryRegion, primaryFocus, primaryCount),
      ...fetchJCCSBank(secondaryRegion, primaryFocus, secondaryCount),
    ];
  }

  await post(`/conference/ROMUNC_2019/assignment/${user}`, {
    title: `学测: ${target.committee}`,
    probs,
    deadline,
  });

  await post(`/conference/ROMUNC_2019/list/${user}/stage`, { stage: 'exam' }, 'PUT');

  const early = new Date('2019-05-04T00:00:00+0800');
  const fast = new Date();
  fast.setDate(fast.getDate() + 7);

  let discounts;

  if(early < new Date()) {
    discounts = [{
      amount: 20,
      desc: '快速缴费优惠',
      until: fast.toISOString(),
    }];
  } else if(early < fast) {
    discounts = [{
      amount: 10,
      desc: '早鸟优惠',
      until: early.toISOString(),
    }, {
      amount: 20,
      desc: '快速缴费优惠',
      until: fast.toISOString(),
    }];
  } else {
    discounts = [{
      amount: 30,
      desc: '早鸟优惠',
      until: early.toISOString(),
    }];
  }

  await post(`/conference/ROMUNC_2019/payment/${user}`, {
    total: 880,
    desc: '会费',
    detail: 'ROMUNC 2019 会费，包括: 开闭幕式及会议场地租赁费用；会期内人身综合意外险一份；学术研究支出；线上系统开发及维护支出；会议物料（展架、席卡、身份牌、会议手册、打印机、路由器等）；均摊组织团队工作所需支出（面试补贴、路费补贴、住宿补贴、餐饮补贴等）；均摊志愿者餐饮补贴等。不包含：住宿费；餐费；因损坏酒店设施需要进行的赔偿等。',
    discounts,
  });

  return true;
}

const app = new Koa();

app.use(Bodyparser());

app.use(async ctx => {
  console.log(ctx.request.body);
  const { type, payload } = ctx.request.body;
  if(type !== 'new-reg') return ctx.status = 201;

  const { user, reg, stage } = payload;

  try {
    await acceptUser(user, reg, stage);
    console.log(`Success on user ${user}`);
  } catch(e) {
    console.error(`Failed on user ${user}`);
    console.error(e);
  }
});

async function bootstrap() {
  console.log('>> Bootstrap sync');
  const list = await get('/conference/ROMUNC_2019/list');
  for(const reg of list) {
    const resp = await acceptUser(reg.user._id, reg.reg, reg.stage);
    if(!resp) console.log(`Skipped ${reg.user._id}`);
    else console.log(`Success on ${reg.user._id}`);
  }
}

// The part to sync tags related to interviews
async function interviewLoop() {
  console.log('>> Interview Loop');

  const list = await get('/conference/ROMUNC_2019/list');

  const interviews = await get('/conference/ROMUNC_2019/interview');
  let assignments = await get('/conference/ROMUNC_2019/assignment');
  let payments = await get('/conference/ROMUNC_2019/payment');

  assignments = assignments.filter(e => e.title.indexOf('学测:') === 0);
  payments = payments.filter(e => e.desc === '会费');

  let changed = 0;

  for(const r of list) {
    const user = r.user;

    const original = [...r.tags];
    const current = original.filter(e => e.indexOf('面试') !== 0);

    const assignment = assignments.find(e => e.assignee._id === user._id);
    const payment = payments.find(e => e.payee._id === user._id);
    const left = interviews.filter(e => e.interviewee._id === user._id);
    if(left.length === 0) {
      if(assignment && payment && payment.status === 'paid' && (
        assignment.submitted || new Date(assignment.deadline) > new Date()
      )) {
        current.push('面试状态:等待分配');
      }
    } else {
      if(left.every(e => !!e.close)) {
        current.push('面试状态:等待转接');
      }

      left.sort((a, b) => new Date(a.creation) - new Date(b.creation));

      let counter = 1;
      for(const round of left) {
        current.push(`面试官:第${counter}轮:${round.interviewer.realname}`);
        ++counter;
      }
    }

    let upload = [...current];
    original.sort();
    current.sort();

    if(original.length !== current.length || original.some((e, i) => e !== current[i])) {
      console.log(`Tag changed for ${user.realname}`);
      console.log(`  >> From ${r.tags.join(', ')}`);
      console.log(`  >> To ${upload.join(', ')}`);
      ++changed;

      await post(`/conference/ROMUNC_2019/list/${user._id}/tags`, upload, 'PUT');
    }
  }
  console.log(`Total changed: ${changed}`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loop() {
  while(true) {
    interviewLoop();
    await wait(60 * 60 * 1000);
  }
}

// Avoid racing (to a certain extend)
bootstrap().then(() => {
  loop();
  app.listen(14232, () => {
    console.log('>> Server up at 14232');
  });
});
