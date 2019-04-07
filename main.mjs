import fetch from 'node-fetch';

import bank from './bank';

import Koa from 'koa';
import Bodyparser from 'koa-bodyparser';

import und from 'underscore';

import { key, base } from './config';

async function parseResp(resp) {
  if(resp.status === 204) return null;
  else if(resp.status >= 400)
    throw await FetchError.from(resp);
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
    const easier = und.sample(bank[target.committee].easy);
    const harder = und.sample(bank[target.committee].hard);
    probs = [easier, harder];
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

// Avoid racing (to a certain extend)
bootstrap().then(() => {
  app.listen(14232, () => {
    console.log('>> Server up at 14232');
  });
});
