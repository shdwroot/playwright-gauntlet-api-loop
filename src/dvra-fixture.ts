import { DVRA_HTTP_FIXTURE, DVRA_IMAGE_BASE64 } from './dvra-http-fixture.js';

// Adapter for the local RESTaurant SQLAlchemy lab. It only touches per-unit
// namespaced users and their descendants; it never resets the shared database.
export const DVRA_FIXTURE = String.raw`
import sys, json, re, datetime, hashlib, base64, urllib.request, urllib.parse, urllib.error, subprocess, time
from db.session import SessionLocal
from db.models import User, UserRole, MenuItem, Order, OrderItem, OrderStatus, DiscountCoupon
from apis.auth.utils import get_password_hash, verify_password

action, namespace = sys.argv[1:3]
api_origin = sys.argv[3] if len(sys.argv) > 3 else 'http://127.0.0.1:8091'
origin = urllib.parse.urlparse(api_origin)
if origin.scheme != 'http' or origin.hostname not in ['127.0.0.1','localhost','::1'] or origin.path not in ['','/'] or origin.query or origin.fragment or origin.username or origin.password:
    raise ValueError('Invalid fixture API origin')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(NoRedirect)
http_fixture_source = ${JSON.stringify(DVRA_HTTP_FIXTURE)}
def fixture_http(port, suffix, method='GET'):
    request = urllib.request.Request('http://127.0.0.1:' + str(port) + suffix,method=method)
    with opener.open(request,timeout=2) as response:
        return json.loads(response.read(32768))
def ensure_fixture_server(port, kind):
    try:
        health = fixture_http(port,'/_gauntlet/health')
    except urllib.error.URLError as error:
        if not isinstance(error.reason,ConnectionRefusedError):
            raise
        subprocess.Popen([sys.executable,'-c',http_fixture_source,str(port),kind],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        health = None
        for _ in range(20):
            time.sleep(0.05)
            try:
                health = fixture_http(port,'/_gauntlet/health')
                break
            except urllib.error.URLError:
                pass
    if health != {'protocol':'gauntlet-image-v1','kind':kind}:
        raise ValueError('Fixture HTTP port unavailable or occupied by another service')
token_actors = json.loads(sys.argv[4]) if len(sys.argv) > 4 else ['customerA','customerB','employee','chef','paginationCustomer','expiredCustomer']
if not isinstance(token_actors,list) or any(name not in ['customerA','customerB','employee','chef','paginationCustomer','expiredCustomer'] for name in token_actors):
    raise ValueError('Invalid fixture actor selection')
if not re.fullmatch(r'gauntlet-[a-f0-9]{24}', namespace):
    raise ValueError('Invalid fixture namespace')
db = SessionLocal()
try:
    if action == 'cleanup':
        users = db.query(User).filter(User.username.like(namespace + '-%')).all()
        user_ids = [u.id for u in users]
        if user_ids:
            order_ids = [o.id for o in db.query(Order).filter(Order.user_id.in_(user_ids)).all()]
            if order_ids:
                db.query(OrderItem).filter(OrderItem.order_id.in_(order_ids)).delete(synchronize_session=False)
                db.query(Order).filter(Order.id.in_(order_ids)).delete(synchronize_session=False)
            db.query(DiscountCoupon).filter((DiscountCoupon.user_id.in_(user_ids)) | (DiscountCoupon.referrer_user_id.in_(user_ids))).delete(synchronize_session=False)
            db.query(User).filter(User.id.in_(user_ids)).delete(synchronize_session=False)
        # Delete only our unreferenced menu records. Never remove somebody else's
        # order item merely because it points to our menu item.
        menus = db.query(MenuItem).filter(MenuItem.name.like(namespace + '-%')).all()
        retained = []
        for menu in menus:
            if db.query(OrderItem).filter(OrderItem.menu_item_id == menu.id).first(): retained.append(menu.id)
            else: db.delete(menu)
        db.commit()
        for port,kind in [(9083,'permitted-image'),(9084,'forbidden-sentinel')]:
            try:
                if fixture_http(port,'/_gauntlet/health') == {'protocol':'gauntlet-image-v1','kind':kind}:
                    fixture_http(port,'/_gauntlet/state/' + namespace,'DELETE')
            except (urllib.error.URLError,ValueError):
                pass
        print(json.dumps({'cleanedUsers': len(user_ids), 'retainedReferencedMenuIds': retained}))
    elif action == 'observe':
        snapshot = {'actors': {}, 'observedAt': datetime.datetime.utcnow().isoformat() + 'Z', '_bindings': {}}
        for name in ['customerA','customerB','employee','chef','paginationCustomer','expiredCustomer']:
            actor = db.query(User).filter(User.username == namespace + '-' + name).first()
            if not actor:
                snapshot['actors'][name] = {'exists': False}
                continue
            try:
                unchanged = verify_password(namespace + '-Password1!', actor.password)
            except Exception:
                unchanged = False
            code = actor.reset_password_code
            expiry = actor.reset_password_code_expiry_date
            snapshot['actors'][name] = {
                'exists': True, 'id': actor.id, 'role': actor.role.value,
                'credentialUnchanged': unchanged,
                'resetInitiated': code is not None,
                'resetFormatValid': bool(code is not None and re.fullmatch(r'\d{4}', str(code))),
                'resetExpiresInSeconds': (expiry - datetime.datetime.utcnow()).total_seconds() if expiry else None,
                'orders': db.query(Order).filter(Order.user_id == actor.id).count(),
                'orderItems': db.query(OrderItem).join(Order).filter(Order.user_id == actor.id).count(),
                'coupons': db.query(DiscountCoupon).filter(DiscountCoupon.user_id == actor.id).count(),
                'usedCoupons': db.query(DiscountCoupon).filter(DiscountCoupon.user_id == actor.id, DiscountCoupon.used == True).count(),
            }
            if name == 'customerA' and code is not None:
                snapshot['_bindings']['fixtureResetCode'] = str(code)
        snapshot['imageRequests'] = fixture_http(9083,'/_gauntlet/state/' + namespace)['requests']
        snapshot['sentinelRequests'] = fixture_http(9084,'/_gauntlet/state/' + namespace)['requests']
        print(json.dumps(snapshot))
    elif action == 'prepare':
        if db.query(User).filter(User.username.like(namespace + '-%')).first():
            raise ValueError('Fixture namespace already exists')
        ensure_fixture_server(9083,'permitted-image')
        ensure_fixture_server(9084,'forbidden-sentinel')
        password = namespace + '-Password1!'
        hashed = get_password_hash(password)
        output = {'runId': namespace, 'fixturePassword': password, 'fixtureResetCode': '7241', 'fixtureExpiredResetCode': '7241',
                  'fixtureImageUrl':'http://127.0.0.1:9083/' + namespace + '/image.png',
                  'fixtureForbiddenImageUrl':'http://127.0.0.1:9084/' + namespace + '/image.png',
                  'fixtureImageBase64':'${DVRA_IMAGE_BASE64}'}
        actors = {}
        for i, (name, role) in enumerate([('customerA', UserRole.CUSTOMER), ('customerB', UserRole.CUSTOMER), ('employee', UserRole.EMPLOYEE), ('chef', UserRole.CHEF), ('paginationCustomer', UserRole.CUSTOMER), ('expiredCustomer', UserRole.CUSTOMER)]):
            username = namespace + '-' + name
            phone = str(int(hashlib.sha256(username.encode()).hexdigest()[:14], 16))
            actor = User(username=username, password=hashed, phone_number=phone, first_name=name, last_name='Fixture', role=role,
                         reset_password_code='7241' if name in ['customerA','expiredCustomer'] else None,
                         reset_password_code_expiry_date=datetime.datetime.utcnow() + datetime.timedelta(minutes=-1 if name == 'expiredCustomer' else 15) if name in ['customerA','expiredCustomer'] else None)
            db.add(actor); db.flush(); actors[name] = actor
            output[name + 'Id'] = actor.id
            output[name + 'Username'] = actor.username
            output[name + 'Phone'] = actor.phone_number
        menu = MenuItem(name=namespace + '-menu', price=10.0, category='Fixture', description='Disposable test record')
        unused = MenuItem(name=namespace + '-unreferenced', price=12.0, category='Fixture')
        db.add_all([menu, unused]); db.flush()
        order = Order(user_id=actors['customerA'].id, status=OrderStatus.PENDING, delivery_address='Fixture address', phone_number=actors['customerA'].phone_number, final_price=10.0)
        db.add(order); db.flush(); db.add(OrderItem(order_id=order.id, menu_item_id=menu.id, quantity=1))
        coupon = DiscountCoupon(user_id=actors['customerA'].id,referrer_user_id=actors['customerB'].id,discount_percentage=20,used=False)
        db.add(coupon);db.flush();output['fixtureCouponId']=coupon.id
        # A separate actor makes the documented default limit observable without
        # changing Customer A's one-order or Customer B's empty precondition.
        pages = [Order(user_id=actors['paginationCustomer'].id, status=OrderStatus.PENDING, delivery_address='Pagination fixture', phone_number=actors['paginationCustomer'].phone_number, final_price=10.0) for _ in range(101)]
        db.add_all(pages); db.flush()
        db.add_all([OrderItem(order_id=item.id, menu_item_id=menu.id, quantity=1) for item in pages])
        output['paginationOrderCount'] = len(pages)
        db.commit()
        output.update({'fixtureMenuId': menu.id, 'fixtureUnusedMenuId': unused.id, 'fixtureOrderId': order.id})
        # Use the actual issuer. Importing its signing helper in this separate
        # process is invalid when the application uses a process-local fallback key.
        for name in token_actors:
            data = urllib.parse.urlencode({'username':actors[name].username,'password':password,'grant_type':'password'}).encode()
            request = urllib.request.Request(api_origin.rstrip('/') + '/token',data=data,headers={'Content-Type':'application/x-www-form-urlencoded'},method='POST')
            with opener.open(request,timeout=5) as response:
                raw = response.read(32769)
                if len(raw) > 32768:
                    raise ValueError('Fixture token response exceeds limit')
                token = json.loads(raw).get('access_token')
            if not isinstance(token,str) or not token:
                raise ValueError('Fixture token endpoint returned no token')
            output[name + 'Token'] = token
        if 'customerAToken' in output:
            parts = output['customerAToken'].split('.')
            payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
            payload['sub'] = actors['customerB'].username
            parts[1] = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
            output['tamperedSubjectToken'] = '.'.join(parts)
        print(json.dumps(output))
    else:
        raise ValueError('Unknown fixture action')
except:
    db.rollback()
    raise
finally:
    db.close()
`;
