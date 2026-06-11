/*
 * sample-data.js
 * Demonstration booking data so the calendar can be viewed before live
 * Pipedrive credentials are connected. These records mirror the shape of a
 * booking produced by the sync service (see lib/transform.js).
 *
 * In live mode this file is ignored and bookings are loaded from /api/bookings.
 * Dates are generated relative to "today" so the board always looks current.
 */
(function () {
  function iso(offsetDays) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  }

  window.NEXUS_SAMPLE_BOOKINGS = [
    {
      id: 'demo-1', pipedriveDealId: 4821,
      customer: 'Jemena Asset Management', contact: 'Dave Renton',
      site: 'Broadmeadows Zone Substation', suburb: 'Broadmeadows VIC',
      jobType: 'planned-outage', generatorSize: '500 kVA',
      equipmentId: 'GEN-500-02', startDate: iso(0), endDate: iso(0),
      durationDays: 1, dealOwner: 'Sarah Phillips', status: 'confirmed',
      deliveryRequired: true, electricalConnectionRequired: true,
      notes: 'Planned outage 0600-1600. Switchboard access via gate 3.'
    },
    {
      id: 'demo-2', pipedriveDealId: 4833,
      customer: 'AusNet Services', contact: 'Priya Nair',
      site: 'Mount Beauty Township Feeder', suburb: 'Mount Beauty VIC',
      jobType: 'planned-outage', generatorSize: '250 kVA',
      equipmentId: 'GEN-250-01', startDate: iso(0), endDate: iso(0),
      durationDays: 1, dealOwner: 'Sarah Phillips', status: 'needs-equipment',
      deliveryRequired: true, electricalConnectionRequired: true,
      notes: 'Equipment not yet allocated. Confirm fleet availability.'
    },
    {
      id: 'demo-3', pipedriveDealId: 4840,
      customer: 'Downer Group', contact: 'Mick Sullivan',
      site: 'Werribee Treatment Plant', suburb: 'Werribee VIC',
      jobType: 'general', generatorSize: '1000 kVA',
      equipmentId: 'GEN-1000-01', startDate: iso(1), endDate: iso(6),
      durationDays: 6, dealOwner: 'Tom Becker', status: 'confirmed',
      deliveryRequired: true, electricalConnectionRequired: false,
      notes: '6 day standby hire for plant upgrade works.'
    },
    {
      id: 'demo-4', pipedriveDealId: 4855,
      customer: 'CitiPower', contact: 'Helen Zhao',
      site: 'Docklands Distribution', suburb: 'Docklands VIC',
      jobType: 'planned-outage', generatorSize: '',
      equipmentId: '', startDate: iso(2), endDate: null,
      durationDays: null, dealOwner: 'Tom Becker', status: 'needs-duration',
      deliveryRequired: true, electricalConnectionRequired: true,
      notes: 'Won deal. Duration not entered in Pipedrive. Defaulted to 1 day visual.'
    },
    {
      id: 'demo-5', pipedriveDealId: 4861,
      customer: 'Powercor', contact: 'Raj Mehta',
      site: 'Ballarat North Zone', suburb: 'Ballarat VIC',
      jobType: 'emergency', generatorSize: '750 kVA',
      equipmentId: 'GEN-750-01', startDate: iso(3), endDate: iso(4),
      durationDays: 2, dealOwner: 'Sarah Phillips', status: 'confirmed',
      deliveryRequired: true, electricalConnectionRequired: true,
      notes: 'Emergency hire following transformer fault.'
    },
    {
      id: 'demo-6', pipedriveDealId: 4870,
      customer: 'United Energy', contact: 'Karen Wallace',
      site: 'Frankston South Feeder', suburb: 'Frankston VIC',
      jobType: 'general', generatorSize: '500 kVA',
      equipmentId: 'GEN-500-02', startDate: iso(0), endDate: iso(2),
      durationDays: 3, dealOwner: 'Tom Becker', status: 'confirmed',
      deliveryRequired: true, electricalConnectionRequired: true,
      notes: 'NOTE: GEN-500-02 also booked today on demo-1 - fleet conflict expected.'
    },
    {
      id: 'demo-7', pipedriveDealId: 4888,
      customer: 'Service Stream', contact: 'Paul Adams',
      site: 'Sunshine West Works', suburb: 'Sunshine West VIC',
      jobType: 'general', generatorSize: '',
      equipmentId: '', startDate: '', endDate: null,
      durationDays: null, dealOwner: 'Tom Becker', status: 'needs-review',
      deliveryRequired: false, electricalConnectionRequired: false,
      notes: 'Won hire deal missing start date, duration and equipment. Needs review.'
    },
    {
      id: 'demo-8', pipedriveDealId: 4795,
      customer: 'Zinfra', contact: 'Lucy Tran',
      site: 'Geelong Ring Main', suburb: 'Geelong VIC',
      jobType: 'planned-outage', generatorSize: '250 kVA',
      equipmentId: 'GEN-250-02', startDate: iso(-3), endDate: iso(-3),
      durationDays: 1, dealOwner: 'Sarah Phillips', status: 'completed',
      deliveryRequired: true, electricalConnectionRequired: true,
      notes: 'Completed planned outage. Retained for history.'
    }
  ];
})();
