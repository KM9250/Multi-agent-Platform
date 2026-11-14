import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { localMacpHost } from './notification-macp-fixture.ts';
const [path,endpoint,workflowRunId]=process.argv.slice(2),token=process.env.MACP_TEST_TOKEN;
if(!path||!endpoint||!workflowRunId||!token)throw new Error('SYNTHETIC_CONFIGURATION_REQUIRED');
const host=localMacpHost(endpoint,token),db=new DurableDatabase({path,notifications:host.options});
try {
  await db.notifications.runOnce(host.credential,{workflowRunId});
  const view=db.notifications.read(host.human,{workflowRunId});
  process.stdout.write(JSON.stringify({states:view.items.map(v=>v.state),calls:host.stats.calls})+'\n');
} finally { db.close(); }
