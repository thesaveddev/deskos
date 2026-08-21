-- ReyDesk schema: match directory-discovered devices to enrolled agents.
--
-- Directory sync (Entra/Intune + on-prem AD) imports devices as inventory-only
-- records (`source <> 'agent'`). When the agent later enrols or reports
-- inventory on the same physical machine, we recognise it by serial number
-- (or hostname) and link the two records together rather than leaving the
-- directory record as an apparent duplicate. `agent_device_id` points from the
-- directory record to the live, agent-managed device.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_device_id uuid REFERENCES devices(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS devices_agent_device_idx ON devices (agent_device_id) WHERE agent_device_id IS NOT NULL;

-- A directory record whose serial matches a live agent should be easy to find.
CREATE INDEX IF NOT EXISTS devices_serial_lookup_idx ON devices (tenant_id, serial_number) WHERE serial_number <> '';
