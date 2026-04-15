-- Remove Comunidade component from system_components table
DELETE FROM system_components WHERE name = 'Comunidade';

-- Also remove any related history records
DELETE FROM system_status_history WHERE component_id IN (
    SELECT id FROM system_components WHERE name = 'Comunidade'
);